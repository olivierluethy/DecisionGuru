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

    flow = [Paragraph(str(body.get("title") or ""), title_style)]
    if body.get("subtitle"):
        flow.append(Paragraph(str(body["subtitle"]), subtitle_style))

    chart = body.get("chartImage")
    if isinstance(chart, str) and chart.startswith("data:image"):
        try:
            raw = base64.b64decode(chart.split(",", 1)[1])
            reader = ImageReader(io.BytesIO(raw))
            iw, ih = reader.getSize()
            width = 500
            height = width * ih / iw if iw else 250
            flow.append(Spacer(1, 10))
            flow.append(Image(io.BytesIO(raw), width=width, height=height))
            flow.append(Spacer(1, 10))
        except Exception:  # noqa: BLE001
            pass

    for table in (body.get("tables") or []):
        if table.get("title"):
            flow.append(Paragraph(str(table["title"]), h2_style))
        headers = table.get("headers") or []
        data = [[Paragraph(str(h), th_style) for h in headers]]
        for r in (table.get("rows") or []):
            data.append([Paragraph(str(c), td_style) for c in r])
        tbl = Table(data, repeatRows=1, hAlign="LEFT")
        tbl.setStyle(TableStyle([
            ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#cccccc")),
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#f0f0f0")),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ]))
        flow.append(tbl)

    if body.get("notes"):
        flow.append(Paragraph("Notes", h2_style))
        for n in body["notes"]:
            flow.append(Paragraph(str(n), note_style))

    disclaimer = body.get("disclaimer") or \
        "Not financial advice. Figures are model estimates — see docs/TAX-MODEL.md."
    flow.append(Paragraph(disclaimer, disclaimer_style))

    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4, leftMargin=40, rightMargin=40,
                            topMargin=40, bottomMargin=40)
    doc.build(flow)
    return buf.getvalue()


def _build_docx(body: dict) -> bytes:
    from docx import Document
    from docx.shared import Inches, Pt, RGBColor

    doc = Document()
    title = doc.add_paragraph()
    run = title.add_run(str(body.get("title") or ""))
    run.bold = True
    run.font.size = Pt(18)
    if body.get("subtitle"):
        sub = doc.add_paragraph(str(body["subtitle"]))
        sub.runs[0].font.color.rgb = RGBColor(0x66, 0x66, 0x66)

    chart = body.get("chartImage")
    if isinstance(chart, str) and chart.startswith("data:image"):
        try:
            raw = base64.b64decode(chart.split(",", 1)[1])
            doc.add_picture(io.BytesIO(raw), width=Inches(6.0))
        except Exception:  # noqa: BLE001
            pass

    for table in (body.get("tables") or []):
        if table.get("title"):
            h = doc.add_paragraph()
            hr = h.add_run(str(table["title"]))
            hr.bold = True
            hr.font.size = Pt(12)
        headers = table.get("headers") or []
        rows = table.get("rows") or []
        t = doc.add_table(rows=1, cols=max(len(headers), 1))
        t.style = "Light Grid Accent 1"
        for i, htext in enumerate(headers):
            cell = t.rows[0].cells[i]
            cell.text = str(htext)
            for p in cell.paragraphs:
                for r in p.runs:
                    r.bold = True
        for row in rows:
            cells = t.add_row().cells
            for i, val in enumerate(row):
                if i < len(cells):
                    cells[i].text = str(val)

    if body.get("notes"):
        nh = doc.add_paragraph()
        nh.add_run("Notes").bold = True
        for n in body["notes"]:
            doc.add_paragraph(str(n))

    disc = doc.add_paragraph(
        str(body.get("disclaimer")
            or "Not financial advice. Figures are model estimates — see docs/TAX-MODEL.md."))
    disc.runs[0].italic = True
    disc.runs[0].font.size = Pt(7)
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
