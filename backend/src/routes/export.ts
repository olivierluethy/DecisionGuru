import { Router } from 'express';
import ExcelJS from 'exceljs';
import PdfPrinter from 'pdfmake';
import type { TDocumentDefinitions, Content } from 'pdfmake/interfaces.js';

export const exportRouter = Router();

// Use pdfkit's built-in standard fonts — no TTF files needed.
const printer = new PdfPrinter({
  Helvetica: {
    normal: 'Helvetica',
    bold: 'Helvetica-Bold',
    italics: 'Helvetica-Oblique',
    bolditalics: 'Helvetica-BoldOblique',
  },
});

interface ExportTable {
  title?: string;
  headers: string[];
  rows: (string | number)[][];
}

interface ExcelBody {
  title: string;
  sheets: { name: string; table: ExportTable }[];
}

interface PdfBody {
  title: string;
  subtitle?: string;
  tables: ExportTable[];
  notes?: string[];
  chartImage?: string; // dataURL png
  disclaimer?: string;
}

exportRouter.post('/excel', async (req, res) => {
  const body = req.body as ExcelBody;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'DecisionGuru';
  wb.created = new Date();
  for (const sheet of body.sheets ?? []) {
    const ws = wb.addWorksheet(sheet.name.slice(0, 31) || 'Sheet');
    ws.addRow(sheet.table.headers);
    ws.getRow(1).font = { bold: true };
    for (const r of sheet.table.rows) ws.addRow(r);
    ws.columns.forEach((col) => {
      let max = 10;
      col.eachCell?.({ includeEmpty: true }, (cell) => {
        max = Math.max(max, String(cell.value ?? '').length + 2);
      });
      col.width = Math.min(max, 42);
    });
  }
  const buffer = await wb.xlsx.writeBuffer();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${safeName(body.title)}.xlsx"`);
  res.end(Buffer.from(buffer));
});

exportRouter.post('/pdf', (req, res) => {
  const body = req.body as PdfBody;
  const content: Content[] = [
    { text: body.title, style: 'title' },
    ...(body.subtitle ? [{ text: body.subtitle, style: 'subtitle' } as Content] : []),
  ];

  if (body.chartImage && body.chartImage.startsWith('data:image')) {
    content.push({ image: body.chartImage, width: 500, margin: [0, 10, 0, 10] });
  }

  for (const table of body.tables ?? []) {
    if (table.title) content.push({ text: table.title, style: 'h2', margin: [0, 12, 0, 4] });
    content.push({
      table: {
        headerRows: 1,
        widths: table.headers.map(() => '*'),
        body: [
          table.headers.map((h) => ({ text: h, style: 'th' })),
          ...table.rows.map((r) => r.map((c) => ({ text: String(c), style: 'td' }))),
        ],
      },
      layout: {
        hLineColor: () => '#cccccc',
        vLineColor: () => '#cccccc',
        hLineWidth: () => 0.5,
        vLineWidth: () => 0.5,
      },
    });
  }

  if (body.notes?.length) {
    content.push({ text: 'Notes', style: 'h2', margin: [0, 14, 0, 4] });
    for (const n of body.notes) content.push({ text: n, style: 'note', margin: [0, 0, 0, 4] });
  }

  content.push({
    text: body.disclaimer ?? 'Not financial advice. Figures are model estimates — see docs/TAX-MODEL.md.',
    style: 'disclaimer',
    margin: [0, 24, 0, 0],
  });

  const doc: TDocumentDefinitions = {
    content,
    defaultStyle: { font: 'Helvetica', fontSize: 9, color: '#1a1a1a' },
    pageMargins: [40, 40, 40, 40],
    styles: {
      title: { fontSize: 18, bold: true, margin: [0, 0, 0, 2] },
      subtitle: { fontSize: 11, color: '#666666', margin: [0, 0, 0, 8] },
      h2: { fontSize: 12, bold: true },
      th: { bold: true, fontSize: 8, fillColor: '#f0f0f0' },
      td: { fontSize: 8 },
      note: { fontSize: 9, italics: true, color: '#333333' },
      disclaimer: { fontSize: 7, color: '#999999', italics: true },
    },
  };

  const pdfDoc = printer.createPdfKitDocument(doc);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${safeName(body.title)}.pdf"`);
  pdfDoc.pipe(res);
  pdfDoc.end();
});

function safeName(s: string): string {
  return (s || 'decisionguru-export').replace(/[^a-z0-9-_]+/gi, '-').slice(0, 60);
}
