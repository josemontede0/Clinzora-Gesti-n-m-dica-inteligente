import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { formatMoney } from '@medigest/shared';
import type { TabularReport } from './reports.service';

export async function toXlsx(report: TabularReport, meta: { organization: string; period: string; generatedBy: string }): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'MediGest';
  const ws = wb.addWorksheet(report.title.slice(0, 30));
  ws.addRow([`${meta.organization} — ${report.title}`]).font = { bold: true, size: 13 };
  ws.addRow([`Período: ${meta.period}`]);
  ws.addRow([`Generado por ${meta.generatedBy} el ${new Date().toLocaleString('es-DO')}`]);
  ws.addRow([]);
  const header = ws.addRow(report.columns.map((c) => c.label));
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.eachCell((cell) => (cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F2A47' } }));
  for (const row of report.rows) {
    ws.addRow(report.columns.map((c) => (c.money && row[c.key] !== '' && row[c.key] != null ? Number(row[c.key]) : row[c.key])));
  }
  if (report.totals) {
    const t = ws.addRow(report.columns.map((c, i) => (report.totals![c.key] != null ? (c.money ? Number(report.totals![c.key]) : report.totals![c.key]) : i === 0 ? 'Totales' : '')));
    t.font = { bold: true };
  }
  report.columns.forEach((c, i) => {
    const col = ws.getColumn(i + 1);
    col.width = Math.max(12, c.label.length + 4);
    if (c.money) col.numFmt = '#,##0.00';
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export function toPdf(report: TabularReport, meta: { organization: string; period: string; generatedBy: string }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', layout: report.columns.length > 6 ? 'landscape' : 'portrait', margin: 36 });
    const chunks: Buffer[] = [];
    doc.on('data', (d: Buffer) => chunks.push(d));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const width = doc.page.width - 72;
    const colW = width / report.columns.length;
    doc.fontSize(14).fillColor('#0F2A47').text(`${meta.organization} — ${report.title}`);
    doc.fontSize(9).fillColor('#555').text(`Período: ${meta.period} · Generado por ${meta.generatedBy} el ${new Date().toLocaleString('es-DO')}`);
    doc.moveDown(0.8);

    const drawRow = (cells: string[], bold = false) => {
      const y = doc.y;
      const heights = cells.map((t) => doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8).heightOfString(t, { width: colW - 4 }));
      const h = Math.max(...heights, 10) + 4;
      if (y + h > doc.page.height - 40) {
        doc.addPage();
      }
      const yy = doc.y;
      cells.forEach((t, i) => {
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8).fillColor('#111')
          .text(t, 36 + i * colW + 2, yy + 2, { width: colW - 4, align: report.columns[i].money ? 'right' : 'left' });
      });
      doc.y = yy + h;
      doc.moveTo(36, doc.y).lineTo(36 + width, doc.y).strokeColor('#ddd').lineWidth(0.5).stroke();
    };

    drawRow(report.columns.map((c) => c.label), true);
    for (const row of report.rows) {
      drawRow(report.columns.map((c) => (c.money && row[c.key] !== '' && row[c.key] != null ? formatMoney(String(row[c.key])) : String(row[c.key] ?? ''))));
    }
    if (report.totals) {
      drawRow(report.columns.map((c, i) => (report.totals![c.key] != null ? (c.money ? formatMoney(report.totals![c.key]) : report.totals![c.key]) : i === 0 ? 'Totales' : '')), true);
    }
    doc.end();
  });
}
