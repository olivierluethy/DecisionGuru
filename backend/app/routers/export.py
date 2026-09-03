from __future__ import annotations

import base64
import io
import re

from fastapi import APIRouter, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import Response

router = APIRouter()

XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


def _safe_name(s: str) -> str:
    return re.sub(r"[^a-z0-9\-_]+", "-", s or "decisionguru-export", flags=re.I)[:60]


def _blocks_of(body: dict) -> list[dict]:
    """The document's content blocks, in the order they should be laid out.

    `blocks` is the current shape: an ordered, heterogeneous list, which is what lets an
    analysis interleave a prose finding with the table it is drawn from — and what the
    preview's content picker toggles entries of. The older flat keys (`chartImage`,
    `tables`, `notes`) are still accepted and lowered into the same block list, so callers
    that predate this never had to change.
    """
    blocks = body.get("blocks")
    if isinstance(blocks, list) and blocks:
        return [b for b in blocks if isinstance(b, dict)]

    legacy: list[dict] = []
    chart = body.get("chartImage")
    if isinstance(chart, str) and chart.startswith("data:image"):
        legacy.append({"kind": "chart", "image": chart})
    for table in (body.get("tables") or []):
        legacy.append({"kind": "table", **table})
    if body.get("notes"):
        legacy.append({"kind": "notes", "title": "Notes", "items": body["notes"]})
    return legacy


# Charts are rasterised client-side at 2x, so an image's pixel width is twice its on-screen
# width. Points ~= CSS pixels at 96dpi, hence the halving.
RASTER_SCALE = 2
# Full content width of the A4 body (595pt page - 40pt margins, rounded down).
MAX_IMAGE_WIDTH = 500


def _image_width(pixel_width: int) -> float:
    """Layout width in points — never wider than the page, never UPSCALED past its own size.

    Without the second half a 28x28 swatch is stretched to 500pt and lands as a blurred
    full-width blob. An image that is genuinely small should render small.
    """
    if not pixel_width:
        return MAX_IMAGE_WIDTH
    return min(MAX_IMAGE_WIDTH, pixel_width / RASTER_SCALE)


def _decode_image(src: object) -> bytes | None:
    """Raw bytes of a `data:image/...;base64,...` URI, or None for anything else."""
    if not isinstance(src, str) or not src.startswith("data:image"):
        return None
    try:
        return base64.b64decode(src.split(",", 1)[1])
    except Exception:  # noqa: BLE001 — a broken image must never sink the document
        return None


def _build_excel(body: dict) -> bytes:
    from openpyxl import Workbook
    from openpyxl.styles import Font

    wb = Workbook()
    wb.remove(wb.active)  # drop the default sheet
    for sheet in (body.get("sheets") or []):
        table = sheet.get("table") or {}
        ws = wb.create_sheet((sheet.get("name") or "Sheet")[:31] or "Sheet")
        headers = table.get("headers") or []
        ws.append(headers)
        for cell in ws[1]:
            cell.font = Font(bold=True)
        for r in (table.get("rows") or []):
            ws.append(list(r))
        # Column autosize: min 10, +2 padding, cap 42 (mirrors the Node exporter).
        for col_idx in range(1, (len(headers) or 1) + 1):
            max_len = 10
            for row in ws.iter_rows(min_col=col_idx, max_col=col_idx):
                for cell in row:
                    max_len = max(max_len, len(str(cell.value if cell.value is not None else "")) + 2)
            ws.column_dimensions[ws.cell(row=1, column=col_idx).column_letter].width = min(max_len, 42)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def _build_pdf(body: dict) -> bytes:
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.utils import ImageReader
    from reportlab.platypus import Image, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

    styles = getSampleStyleSheet()
    title_style = ParagraphStyle("dgTitle", parent=styles["Title"], fontName="Helvetica-Bold",
                                 fontSize=18, spaceAfter=2, alignment=0)
    subtitle_style = ParagraphStyle("dgSubtitle", parent=styles["Normal"], fontSize=11,
                                    textColor=colors.HexColor("#666666"), spaceAfter=8)
    h2_style = ParagraphStyle("dgH2", parent=styles["Normal"], fontName="Helvetica-Bold",
                              fontSize=12, spaceBefore=12, spaceAfter=4)
    note_style = ParagraphStyle("dgNote", parent=styles["Normal"], fontName="Helvetica-Oblique",
                               fontSize=9, textColor=colors.HexColor("#333333"), spaceAfter=4)
    disclaimer_style = ParagraphStyle("dgDisc", parent=styles["Normal"], fontName="Helvetica-Oblique",
                                      fontSize=7, textColor=colors.HexColor("#999999"), spaceBefore=24)
    td_style = ParagraphStyle("dgTd", parent=styles["Normal"], fontSize=8)
    th_style = ParagraphStyle("dgTh", parent=styles["Normal"], fontName="Helvetica-Bold", fontSize=8)

    body_style = ParagraphStyle("dgBody", parent=styles["Normal"], fontSize=9.5,
                                leading=13, spaceAfter=6)
    meta_style = ParagraphStyle("dgMeta", parent=styles["Normal"], fontSize=8.5,
                                textColor=colors.HexColor("#555555"), spaceAfter=10)

    flow = [Paragraph(str(body.get("title") or ""), title_style)]
    if body.get("subtitle"):
        flow.append(Paragraph(str(body["subtitle"]), subtitle_style))

    # Context line — as-of date, currency, benchmark. One row, so it reads as provenance
    # rather than as content.
    meta = [m for m in (body.get("meta") or []) if isinstance(m, dict) and m.get("label")]
    if meta:
        flow.append(Paragraph(
            "   ·   ".join(f"<b>{m['label']}</b> {m.get('value', '')}" for m in meta),
            meta_style))

    for block in _blocks_of(body):
        kind = block.get("kind")
        if kind == "chart":
            raw = _decode_image(block.get("image"))
            if raw is None:
                continue
            if block.get("title"):
                flow.append(Paragraph(str(block["title"]), h2_style))
            reader = ImageReader(io.BytesIO(raw))
            iw, ih = reader.getSize()
            width = _image_width(iw)
            height = width * ih / iw if iw else 250
            flow.append(Spacer(1, 10))
            flow.append(Image(io.BytesIO(raw), width=width, height=height))
            flow.append(Spacer(1, 10))
        elif kind == "text":
            if block.get("title"):
                flow.append(Paragraph(str(block["title"]), h2_style))
            for para in str(block.get("body") or "").split("\n\n"):
                if para.strip():
                    flow.append(Paragraph(para.strip(), body_style))
        elif kind == "notes":
            flow.append(Paragraph(str(block.get("title") or "Notes"), h2_style))
            for n in (block.get("items") or []):
                flow.append(Paragraph(str(n), note_style))
        else:  # table
            if block.get("title"):
                flow.append(Paragraph(str(block["title"]), h2_style))
            headers = block.get("headers") or []
            data = [[Paragraph(str(h), th_style) for h in headers]]
            for r in (block.get("rows") or []):
                data.append([Paragraph(str(c), td_style) for c in r])
            tbl = Table(data, repeatRows=1, hAlign="LEFT")
            tbl.setStyle(TableStyle([
                ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#cccccc")),
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#f0f0f0")),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ]))
            flow.append(tbl)

    disclaimer = body.get("disclaimer") or \
        "Not financial advice. Figures are model estimates — see docs/TAX-MODEL.md."
    flow.append(Paragraph(disclaimer, disclaimer_style))

    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4, leftMargin=40, rightMargin=40,
                            topMargin=40, bottomMargin=40)
    doc.build(flow)
    return buf.getvalue()


def _build_docx(body: dict) -> bytes:
    """A real Word document, not a text dump with bold lines.

    The default python-docx template is US Letter with 1.25" margins and a `Normal` style
    that sets neither paragraph spacing nor line spacing — which is why the output used to
    read as one unbroken wall of text on the wrong paper. The page is set to A4 to match the
    PDF, and the document uses Word's OWN styles (Title, Heading 1, Normal) rather than
    ad-hoc bold runs: that is what makes Word's navigation pane, table of contents and style
    pane work on the file, and what lets a preview find its headings.

    Pagination stays Word's job. A .docx carries no page breaks until Word lays it out, and
    guessing them here would produce breaks in places Word would not choose.
    """
    from docx import Document
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.shared import Cm, Emu, Inches, Pt, RGBColor

    doc = Document()

    section = doc.sections[0]
    section.page_width, section.page_height = Cm(21.0), Cm(29.7)   # A4, like the PDF
    section.left_margin = section.right_margin = Cm(2.0)
    section.top_margin = section.bottom_margin = Cm(2.0)
    # Length arithmetic yields a plain EMU int, so convert explicitly.
    content_width_in = Emu(section.page_width - section.left_margin - section.right_margin).inches

    # Body text that breathes. Without these two the paragraphs sit flush against each other.
    normal = doc.styles["Normal"].paragraph_format
    normal.space_after = Pt(8)
    normal.line_spacing = 1.15
    doc.styles["Normal"].font.size = Pt(10.5)

    # Style AND explicit run formatting. The style is what Word reads as structure (its
    # navigation pane, a table of contents); the explicit size/weight is what any other
    # renderer shows, because they do not all resolve the template's theme fonts — leaving
    # a heading indistinguishable from body text in a preview.
    tp = doc.add_paragraph(style="Title")
    tr = tp.add_run(str(body.get("title") or ""))
    tr.bold = True
    tr.font.size = Pt(20)
    if body.get("subtitle"):
        sp = doc.add_paragraph(style="Subtitle")
        sr = sp.add_run(str(body["subtitle"]))
        sr.font.size = Pt(11)
        sr.font.color.rgb = RGBColor(0x66, 0x66, 0x66)

    meta = [m for m in (body.get("meta") or []) if isinstance(m, dict) and m.get("label")]
    if meta:
        mp = doc.add_paragraph()
        mr = mp.add_run("   ·   ".join(f"{m['label']} {m.get('value', '')}" for m in meta))
        mr.font.size = Pt(8.5)
        mr.font.color.rgb = RGBColor(0x55, 0x55, 0x55)

    def _heading(text: str) -> None:
        h = doc.add_heading(level=1)
        h.paragraph_format.space_before = Pt(14)
        h.paragraph_format.space_after = Pt(4)
        run = h.add_run(str(text))
        run.bold = True
        run.font.size = Pt(13)
        run.font.color.rgb = RGBColor(0x1A, 0x1A, 0x1A)

    for block in _blocks_of(body):
        kind = block.get("kind")
        if kind == "chart":
            raw = _decode_image(block.get("image"))
            if raw is None:
                continue
            if block.get("title"):
                _heading(block["title"])
            try:
                from PIL import Image as _PILImage
                try:
                    px_w = _PILImage.open(io.BytesIO(raw)).width
                except Exception:  # noqa: BLE001
                    px_w = 0
                # Never wider than the text column, never upscaled past its own size.
                width_in = min(content_width_in, _image_width(px_w) / 72)
                pic = doc.add_paragraph()
                pic.alignment = WD_ALIGN_PARAGRAPH.CENTER
                pic.add_run().add_picture(io.BytesIO(raw), width=Inches(width_in))
            except Exception:  # noqa: BLE001
                pass
        elif kind == "text":
            if block.get("title"):
                _heading(block["title"])
            for para in str(block.get("body") or "").split("\n\n"):
                if para.strip():
                    doc.add_paragraph(para.strip())
        elif kind == "notes":
            _heading(block.get("title") or "Notes")
            for n in (block.get("items") or []):
                doc.add_paragraph(str(n), style="List Bullet")
        else:  # table
            if block.get("title"):
                _heading(block["title"])
            headers = block.get("headers") or []
            rows = block.get("rows") or []
            tbl = doc.add_table(rows=1, cols=max(len(headers), 1))
            tbl.style = "Light Grid Accent 1"
            tbl.autofit = True
            for i, htext in enumerate(headers):
                cell = tbl.rows[0].cells[i]
                cell.text = str(htext)
                for para in cell.paragraphs:
                    para.paragraph_format.space_after = Pt(2)
                    for r in para.runs:
                        r.bold = True
                        r.font.size = Pt(9)
            for row in rows:
                cells = tbl.add_row().cells
                for i, val in enumerate(row):
                    if i >= len(cells):
                        continue
                    cells[i].text = str(val)
                    for para in cells[i].paragraphs:
                        para.paragraph_format.space_after = Pt(2)
                        for r in para.runs:
                            r.font.size = Pt(9)
            # A table butted straight against the next heading reads as one blob.
            doc.add_paragraph()

    disc = doc.add_paragraph(
        str(body.get("disclaimer")
            or "Not financial advice. Figures are model estimates — see docs/TAX-MODEL.md."))
    disc.runs[0].italic = True
    disc.runs[0].font.size = Pt(7.5)
    disc.runs[0].font.color.rgb = RGBColor(0x99, 0x99, 0x99)

    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()


@router.post("/excel")
async def export_excel(request: Request) -> Response:
    body = await request.json() or {}
    data = await run_in_threadpool(_build_excel, body)
    filename = f"{_safe_name(body.get('title'))}.xlsx"
    return Response(content=data, media_type=XLSX_MIME,
                    headers={"Content-Disposition": f'attachment; filename="{filename}"'})


@router.post("/pdf")
async def export_pdf(request: Request) -> Response:
    body = await request.json() or {}
    data = await run_in_threadpool(_build_pdf, body)
    filename = f"{_safe_name(body.get('title'))}.pdf"
    return Response(content=data, media_type="application/pdf",
                    headers={"Content-Disposition": f'attachment; filename="{filename}"'})


@router.post("/docx")
async def export_docx(request: Request) -> Response:
    body = await request.json() or {}
    data = await run_in_threadpool(_build_docx, body)
    filename = f"{_safe_name(body.get('title'))}.docx"
    return Response(content=data, media_type=DOCX_MIME,
                    headers={"Content-Disposition": f'attachment; filename="{filename}"'})
