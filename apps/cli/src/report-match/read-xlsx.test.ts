import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { compareExport } from './compare.js';
import { ExportRefused, readExport } from './read-export.js';
import { readXlsx, XlsxRefused } from './read-xlsx.js';

/** A real zip, by hand: the parts of a workbook, deflated. */
function zip(parts: Record<string, string>, stored?: { declaredSize: number }): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(parts)) {
    const data = Buffer.from(text, 'utf8');
    const deflated = stored ? data : deflateRawSync(data);
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(stored?.declaredSize ?? data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, deflated);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(20, 6);
    head.writeUInt16LE(stored ? 0 : 8, 10);
    head.writeUInt32LE(deflated.length, 20);
    head.writeUInt32LE(stored?.declaredSize ?? data.length, 24);
    head.writeUInt16LE(nameBytes.length, 28);
    head.writeUInt32LE(offset, 42);
    central.push(head, nameBytes);
    offset += 30 + nameBytes.length + deflated.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(parts).length, 8);
  end.writeUInt16LE(Object.keys(parts).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const WORKBOOK = (extra = '') => `<?xml version="1.0"?><workbook xmlns:r="x">${extra}<sheets><sheet name="Export" sheetId="1" r:id="rId1"/></sheets></workbook>`;
const RELS = `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`;

function workbook(sheet: string, options: { strings?: string; styles?: string; book?: string } = {}): Buffer {
  return zip({
    'xl/workbook.xml': options.book ?? WORKBOOK(),
    'xl/_rels/workbook.xml.rels': RELS,
    'xl/worksheets/sheet1.xml': `<worksheet>${sheet}</worksheet>`,
    ...(options.strings ? { 'xl/sharedStrings.xml': options.strings } : {}),
    ...(options.styles ? { 'xl/styles.xml': options.styles } : {}),
  });
}

describe('reading an .xlsx export', () => {
  it('reads shared, inline and rich text, and number cells as exact', () => {
    const sheet = readXlsx(workbook(
      `<sheetData>
        <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>Sales</t></is></c></row>
        <row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>678781.24</v></c></row>
      </sheetData>`,
      { strings: `<sst><si><t>Region</t></si><si><r><t>Ea</t></r><r><t>st</t></r><rPh><t>ignored</t></rPh></si></sst>` },
    ), 'a.xlsx');
    expect(sheet.rows).toEqual([['Region', 'Sales'], ['East', '678781.24']]);
    expect(sheet.full[1]).toEqual([undefined, 'number']);
    expect(sheet.full[0]).toEqual([undefined, undefined]);
  });

  it('reads a file whose writer prefixes every tag, as Open XML tools can', () => {
    const sheet = readXlsx(zip({
      'xl/workbook.xml': `<?xml version="1.0"?><x:workbook xmlns:x="m" xmlns:r="x"><x:sheets><x:sheet name="Export" sheetId="1" r:id="rId1"/></x:sheets></x:workbook>`,
      'xl/_rels/workbook.xml.rels': RELS,
      'xl/sharedStrings.xml': `<x:sst xmlns:x="m"><x:si><x:t>Region</x:t></x:si><x:si><x:r><x:t>Ea</x:t></x:r><x:r><x:t xml:space="preserve">st</x:t></x:r></x:si></x:sst>`,
      'xl/styles.xml': `<x:styleSheet xmlns:x="m"><x:cellXfs><x:xf numFmtId="14"/></x:cellXfs></x:styleSheet>`,
      'xl/worksheets/sheet1.xml': `<x:worksheet xmlns:x="m"><x:sheetData>
        <x:row r="1"><x:c r="A1" t="s"><x:v>0</x:v></x:c><x:c r="B1" s="0"><x:v>46027</x:v></x:c></x:row>
        <x:row r="2"><x:c r="A2" t="s"><x:v>1</x:v></x:c></x:row>
        <x:row r="3"><x:c r="B3"><x:v>1.5</x:v></x:c></x:row>
      </x:sheetData><x:mergeCells><x:mergeCell ref="A2:A3"/></x:mergeCells></x:worksheet>`,
    }), 'prefixed.xlsx');
    expect(sheet.rows).toEqual([['Region', '2026-01-05'], ['East'], ['East', '1.5']]);
  });

  it('does not run a self-closed value or text run into the next', () => {
    const sheet = readXlsx(workbook(`<sheetData><row r="1"><c r="A1" t="inlineStr"><is><r><t xml:space="preserve"/></r><r><t>x</t></r></is></c><c r="B1"><v/></c></row></sheetData>`), 'n.xlsx');
    expect(sheet.rows[0]).toEqual(['x', '']);
  });

  it('keeps a gap in a row where it is, and decodes entities', () => {
    const sheet = readXlsx(workbook(`<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>a &amp; b</t></is></c><c r="C1"><v>3</v></c></row></sheetData>`), 'b.xlsx');
    expect(sheet.rows).toEqual([['a & b', '', '3']]);
  });

  it('reads booleans, errors and formula text', () => {
    const sheet = readXlsx(workbook(`<sheetData><row r="1"><c r="A1" t="b"><v>1</v></c><c r="B1" t="e"><v>#N/A</v></c><c r="C1" t="str"><f>x</f><v>hi</v></c></row></sheetData>`), 'c.xlsx');
    expect(sheet.rows[0]).toEqual(['true', '#N/A', 'hi']);
  });

  it('turns date cells into dates from their style, a number stays a number', () => {
    const styles = `<styleSheet><numFmts><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/><numFmt numFmtId="165" formatCode="&quot;Day&quot; 0.00"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/><xf numFmtId="165"/></cellXfs></styleSheet>`;
    const sheet = readXlsx(workbook(`<sheetData><row r="1"><c r="A1" s="1"><v>46027</v></c><c r="B1" s="2"><v>46027.5</v></c><c r="C1" s="3"><v>46027</v></c><c r="D1"><v>46027</v></c></row></sheetData>`, { styles }), 'd.xlsx');
    expect(sheet.rows[0]).toEqual(['2026-01-05', '2026-01-05 12:00:00', '46027', '46027']);
    expect(sheet.full[0]).toEqual([undefined, undefined, 'number', 'number']);
  });

  it('takes a date\'s grain from its format, so a printed month stays a month', () => {
    const styles = `<styleSheet><numFmts><numFmt numFmtId="170" formatCode="mmm\\ yyyy"/><numFmt numFmtId="171" formatCode="yyyy"/></numFmts><cellXfs><xf numFmtId="17"/><xf numFmtId="170"/><xf numFmtId="171"/></cellXfs></styleSheet>`;
    const sheet = readXlsx(workbook(`<sheetData><row r="1"><c r="A1" s="0"><v>46027</v></c><c r="B1" s="1"><v>46023</v></c><c r="C1" s="2"><v>46023</v></c></row></sheetData>`, { styles }), 'd2.xlsx');
    expect(sheet.rows[0]).toEqual(['2026-01', '2026-01', '2026']);
  });

  it('does not take a money or scale format for a date, and marks a percent', () => {
    const formats = ['#,##0.00_m', '"Day" 0.00', '[$$-409]#,##0', '0.0,,\\M', '[Red]0.0', 'General'];
    const styles = `<styleSheet><numFmts>${formats.map((code, index) => `<numFmt numFmtId="${170 + index}" formatCode="${code.replace(/"/g, '&quot;')}"/>`).join('')}</numFmts><cellXfs>${formats.map((_, index) => `<xf numFmtId="${170 + index}"/>`).join('')}<xf numFmtId="10"/></cellXfs></styleSheet>`;
    const cells = formats.map((_, index) => `<c r="${String.fromCharCode(65 + index)}1" s="${index}"><v>46027</v></c>`).join('');
    const sheet = readXlsx(workbook(`<sheetData><row r="1">${cells}<c r="G1" s="6"><v>0.149</v></c></row></sheetData>`, { styles }), 'd3.xlsx');
    expect(sheet.rows[0]).toEqual([...formats.map(() => '46027'), '0.149']);
    expect(sheet.full[0]![6]).toBe('percent');
  });

  it('writes Excel\'s exponents as digits, and leaves an absurd date a number', () => {
    const styles = `<styleSheet><cellXfs><xf numFmtId="14"/></cellXfs></styleSheet>`;
    const sheet = readXlsx(workbook(`<sheetData><row r="1"><c r="A1"><v>1.5E-5</v></c><c r="B1"><v>1.0E+21</v></c><c r="C1" s="0"><v>1E+300</v></c></row></sheetData>`, { styles }), 'd4.xlsx');
    expect(Number(sheet.rows[0]![0])).toBeCloseTo(0.000015, 12);
    expect(sheet.rows[0]![0]).toMatch(/^0\.0000/);
    expect(sheet.rows[0]![1]).toBe('1000000000000000000000');
    expect(Number(sheet.rows[0]![2])).toBe(1e300);
  });

  it('counts dates from 1904 when the workbook says so', () => {
    const styles = `<styleSheet><cellXfs><xf numFmtId="14"/></cellXfs></styleSheet>`;
    const sheet = readXlsx(workbook(`<sheetData><row r="1"><c r="A1" s="0"><v>44565</v></c></row></sheetData>`, { styles, book: WORKBOOK('<workbookPr date1904="1"/>') }), 'e.xlsx');
    expect(sheet.rows[0]).toEqual(['2026-01-05']);
  });

  it('fills a merged key down its rows', () => {
    const sheet = readXlsx(workbook(`<sheetData>
      <row r="1"><c r="A1" t="inlineStr"><is><t>East</t></is></c><c r="B1"><v>1</v></c></row>
      <row r="2"><c r="B2"><v>2</v></c></row>
    </sheetData><mergeCells><mergeCell ref="A1:A2"/></mergeCells>`), 'f.xlsx');
    expect(sheet.rows).toEqual([['East', '1'], ['East', '2']]);
  });

  it('skips a hidden sheet, and says when there were others', () => {
    const book = `<workbook xmlns:r="x"><sheets><sheet name="Old" state="hidden" r:id="rId8"/><sheet name="Data" r:id="rId1"/><sheet name="Notes" r:id="rId7"/></sheets></workbook>`;
    const sheet = readXlsx(workbook(`<sheetData><row r="1"><c r="A1"><v>7</v></c></row></sheetData>`, { book }), 'g.xlsx');
    expect(sheet.rows).toEqual([['7']]);
    expect(sheet.notes[0]).toContain('has 2 sheets');
  });

  it('reads the ExportHeaders sheet, and names a hidden sheet it did not read', () => {
    const book = `<workbook xmlns:r="x"><sheets><sheet name="ExportHeaders" state="hidden" r:id="rId2"/><sheet name="Data" r:id="rId1"/><sheet name="Old" state="hidden" r:id="rId3"/></sheets></workbook>`;
    const sheet = readXlsx(zip({
      'xl/workbook.xml': book,
      'xl/_rels/workbook.xml.rels': `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/><Relationship Id="rId3" Target="worksheets/sheet3.xml"/></Relationships>`,
      'xl/worksheets/sheet1.xml': `<worksheet><sheetData><row r="1"><c r="A1"><v>7</v></c></row></sheetData></worksheet>`,
      'xl/worksheets/sheet2.xml': `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Applied filters:</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Region is East</t></is></c></row></sheetData></worksheet>`,
    }), 'g2.xlsx');
    expect(sheet.rows).toEqual([['7']]);
    expect(sheet.details).toEqual(['Applied filters:', 'Region is East']);
    expect(sheet.hiddenSheets).toEqual(['Old']);
  });

  it('finds the workbook, strings and styles where the package says they are', () => {
    const sheet = readXlsx(zip({
      '_rels/.rels': `<Relationships><Relationship Id="rId1" Type="x/officeDocument" Target="book/main.xml"/></Relationships>`,
      'book/main.xml': WORKBOOK(),
      'book/_rels/main.xml.rels': `<Relationships><Relationship Id="rId1" Type="x/worksheet" Target="data/one.xml"/><Relationship Id="rId2" Type="x/sharedStrings" Target="../shared/text.xml"/><Relationship Id="rId3" Type="x/styles" Target="/shared/looks.xml"/></Relationships>`,
      'book/data/one.xml': `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" s="0"><v>46027</v></c></row></sheetData></worksheet>`,
      'shared/text.xml': `<sst><si><t>Region</t></si></sst>`,
      'shared/looks.xml': `<styleSheet><cellXfs><xf numFmtId="14"/></cellXfs></styleSheet>`,
    }), 'paths.xlsx');
    expect(sheet.rows).toEqual([['Region', '2026-01-05']]);
  });

  it('skips a chart sheet at the front', () => {
    const book = `<workbook xmlns:r="x"><sheets><sheet name="Chart" r:id="rId2"/><sheet name="Data" r:id="rId1"/></sheets></workbook>`;
    const sheet = readXlsx(zip({
      'xl/workbook.xml': book,
      'xl/_rels/workbook.xml.rels': `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="x/chartsheet" Target="chartsheets/sheet1.xml"/></Relationships>`,
      'xl/worksheets/sheet1.xml': `<worksheet><sheetData><row r="1"><c r="A1"><v>7</v></c></row></sheetData></worksheet>`,
    }), 'chart.xlsx');
    expect(sheet.rows).toEqual([['7']]);
    expect(sheet.notes).toEqual([]);
  });

  it('prints what the format prints: a code keeps its zeros, elapsed time and East Asian dates read rightly', () => {
    const styles = `<styleSheet><numFmts><numFmt numFmtId="170" formatCode="00000"/><numFmt numFmtId="171" formatCode="[h]:mm"/></numFmts><cellXfs><xf numFmtId="170"/><xf numFmtId="171"/><xf numFmtId="31"/><xf numFmtId="57"/></cellXfs><dxfs><dxf><numFmt numFmtId="170" formatCode="yyyy"/></dxf></dxfs></styleSheet>`;
    const sheet = readXlsx(workbook(`<sheetData><row r="1"><c r="A1" s="0"><v>2134</v></c><c r="B1" s="1"><v>1.5</v></c><c r="C1" s="2"><v>46027</v></c><c r="D1" s="3"><v>46027</v></c></row></sheetData>`, { styles }), 'f.xlsx');
    expect(sheet.rows[0]).toEqual(['02134', '1.5', '2026-01-05', '2026-01-05']);
    expect(sheet.full[0]).toEqual([undefined, 'number', undefined, undefined]);
  });

  it('writes a number as a person would, and reads CDATA as it stands', () => {
    const sheet = readXlsx(workbook(`<sheetData><row r="1"><c r="A1"><v>0.10000000000000001</v></c><c r="B1" t="inlineStr"><is><t><![CDATA[a & b]]></t></is></c></row></sheetData>`), 'n.xlsx');
    expect(sheet.rows[0]).toEqual(['0.1', 'a & b']);
  });

  it('leaves a merged number where it is, and fills a merged key across its columns', () => {
    const number = readXlsx(workbook(`<sheetData><row r="1"><c r="A1"><v>100</v></c></row><row r="2"><c r="B2"><v>1</v></c></row></sheetData><mergeCells><mergeCell ref="A1:A2"/></mergeCells>`), 'm1.xlsx');
    expect(number.rows[1]).toEqual(['', '1']);
    const wide = readXlsx(workbook(`<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>East</t></is></c><c r="C1"><v>1</v></c></row><row r="2"><c r="C2"><v>2</v></c></row></sheetData><mergeCells><mergeCell ref="A1:B2"/></mergeCells>`), 'm2.xlsx');
    expect(wide.rows).toEqual([['East', 'East', '1'], ['East', 'East', '2']]);
    const title = readXlsx(workbook(`<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Sales</t></is></c></row></sheetData><mergeCells><mergeCell ref="A1:C1"/></mergeCells>`), 'm3.xlsx');
    expect(title.rows).toEqual([['Sales']]);
  });

  it('refuses what is not a workbook, and stops at its limits', () => {
    expect(() => readXlsx(Buffer.from('not a zip at all, sorry, not at all'), 'h.xlsx')).toThrow(XlsxRefused);
    expect(() => readXlsx(zip({ 'a.txt': 'x' }), 'i.xlsx')).toThrow('no workbook inside');
    const wide = `<sheetData><row r="1"><c r="ZZZ1"><v>1</v></c></row></sheetData>`;
    expect(() => readXlsx(workbook(wide), 'j.xlsx')).toThrow('more columns');
  });

  it('stops a crafted sheet at the cell limit, without holding millions of empty cells', () => {
    const row = `<row>${'<c/>'.repeat(1_000)}</row>`;
    expect(() => readXlsx(workbook(`<sheetData>${row.repeat(5_001)}</sheetData>`), 'k.xlsx')).toThrow('more cells');
  });

  it('counts a gap in a row as cells, so a row of one far-off cell cannot fill memory', () => {
    const row = '<row><c r="AMJ1"><v>1</v></c></row>';
    expect(() => readXlsx(workbook(`<sheetData>${row.repeat(5_000)}</sheetData>`), 'k2.xlsx')).toThrow('more cells');
  });

  it('stops a crafted merge range, and refuses a merge past the last row quietly', () => {
    const data = `<sheetData>${'<row><c><v>1</v></c></row>'.repeat(3)}</sheetData>`;
    expect(readXlsx(workbook(`${data}<mergeCells><mergeCell ref="A1:A99999999"/></mergeCells>`), 'k3.xlsx').rows).toHaveLength(3);
    const many = `<sheetData>${'<row><c t="inlineStr"><is><t>x</t></is></c></row>'.repeat(120_000)}</sheetData><mergeCells>${'<mergeCell ref="B1:B120000"/><mergeCell ref="A1:A120000"/>'.repeat(50)}</mergeCells>`;
    expect(() => readXlsx(workbook(many), 'k4.xlsx')).toThrow('more merged cells');
    const widened = `<sheetData>${'<row><c t="inlineStr"><is><t>x</t></is></c></row>'.repeat(10_000)}</sheetData><mergeCells><mergeCell ref="A1:AMJ10000"/></mergeCells>`;
    expect(() => readXlsx(workbook(widened), 'k5.xlsx')).toThrow('more merged cells');
  });

  it('stops at the row limit', () => {
    expect(() => readXlsx(workbook(`<sheetData>${'<row><c><v>1</v></c></row>'.repeat(150_011)}</sheetData>`), 'l.xlsx')).toThrow('more rows');
  });

  it('does not read a merge from text inside a cell', () => {
    const sheet = readXlsx(workbook(`<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>&lt;mergeCell ref="A1:A2"/&gt;</t></is></c></row><row r="2"><c r="B2"><v>2</v></c></row></sheetData>`), 'm.xlsx');
    expect(sheet.rows[1]).toEqual(['', '2']);
  });
});

describe('an .xlsx export, read as a table', () => {
  const inline = (text: string) => `t="inlineStr"><is><t>${text}</t></is></c>`;

  it('takes Power BI\'s filter line and overflow note out of the table, and sets a total aside', () => {
    const table = readExport(workbook(`<sheetData>
      <row r="1"><c r="A1" ${inline('Applied filters: Region is East')}</row>
      <row r="2"><c r="A2" ${inline('Region')}<c r="B2" ${inline('Sales')}</row>
      <row r="3"><c r="A3" ${inline('East')}<c r="B3"><v>10.25</v></c></row>
      <row r="4"><c r="A4" ${inline('Total')}<c r="B4"><v>10.25</v></c></row>
      <row r="5"><c r="A5" ${inline('Exported data exceeded the allowed volume')}</row>
    </sheetData>`), 'a.xlsx');
    expect(table.headers).toEqual(['Region', 'Sales']);
    expect(table.rows).toEqual([['East', '10.25']]);
    expect(table.totalsSetAside).toBe(1);
    expect(table.tool).toBe('powerbi');
    expect(table.appliedFilters).toBe('Region is East');
    expect(table.cutShort).toContain('exceeded');
    expect(table.fullValues).toEqual({ Sales: 'number' });
  });

  it('holds a column to its full value only when all of it is Excel numbers', () => {
    const table = readExport(workbook(`<sheetData>
      <row r="1"><c r="A1" ${inline('Region')}<c r="B1" ${inline('Sales')}<c r="C1" ${inline('Profit')}</row>
      <row r="2"><c r="A2" ${inline('East')}<c r="B2"><v>1.5</v></c><c r="C2" ${inline('$1.50')}</row>
      <row r="3"><c r="A3" ${inline('West')}<c r="B3"/><c r="C3"><v>2.5</v></c></row>
    </sheetData>`), 'b.xlsx');
    expect(table.fullValues).toEqual({ Sales: 'number' });
  });

  it('compares a full value strictly: a difference a printed cent would hide still shows', () => {
    const table = readExport(workbook(`<sheetData>
      <row r="1"><c r="A1" ${inline('Region')}<c r="B1" ${inline('Sales')}</row>
      <row r="2"><c r="A2" ${inline('East')}<c r="B2"><v>100.001</v></c></row>
    </sheetData>`), 'c.xlsx');
    const plan = { keys: [{ header: 'Region', output: 'region', kind: 'text' as const }], numbers: [{ header: 'Sales', output: 'sales', name: 'sales' }], notCompared: [] };
    const near = compareExport(table, plan, [{ region: 'East', sales: 100.004 }]);
    expect(near.numbers[0]).toMatchObject({ verdict: 'differs', precision: 'the full value' });
    expect(compareExport(table, plan, [{ region: 'East', sales: 100.001 }]).numbers[0]!.verdict).toBe('matches');
  });

  it('checks a percent cell against a metric held as points', () => {
    const styles = `<styleSheet><cellXfs><xf numFmtId="0"/><xf numFmtId="10"/></cellXfs></styleSheet>`;
    const table = readExport(workbook(`<sheetData>
      <row r="1"><c r="A1" ${inline('Region')}<c r="B1" ${inline('Margin')}</row>
      <row r="2"><c r="A2" ${inline('East')}<c r="B2" s="1"><v>0.149</v></c></row>
    </sheetData>`, { styles }), 'd.xlsx');
    expect(table.fullValues).toEqual({ Margin: 'percent' });
    const plan = { keys: [{ header: 'Region', output: 'region', kind: 'text' as const }], numbers: [{ header: 'Margin', output: 'margin', name: 'margin' }], notCompared: [] };
    expect(compareExport(table, plan, [{ region: 'East', margin: 14.9 }], { pointColumns: new Set(['margin']) }).numbers[0]).toMatchObject({ verdict: 'matches', percentPoints: true });
    expect(compareExport(table, plan, [{ region: 'East', margin: 14.9 }]).numbers[0]!.verdict).toBe('differs');
  });

  it('refuses a damaged workbook and other Excel files, saying what to do', () => {
    expect(() => readExport(zip({ 'xl/workbook.xml': '<workbook><sheets' }), 'e.xlsx')).toThrow(ExportRefused);
    expect(() => readExport(Buffer.from('x'), 'old.xls')).toThrow('Save old.xls as .xlsx or CSV');
  });
});

describe('a crafted file', () => {
  const quick = (run: () => unknown) => {
    const started = Date.now();
    try {
      run();
    } catch {
      // Refused is fine. Slow is not.
    }
    expect(Date.now() - started).toBeLessThan(3_000);
  };
  const inflated = 1_500_000;

  it('can\'t slow the scan of a cell or a string', () => {
    const cell = (inner: string) => workbook(`<sheetData><row r="1"><c r="A1" t="inlineStr"><is>${inner}</is></c></row></sheetData>`);
    quick(() => readXlsx(cell('<t'.repeat(inflated)), 'a.xlsx'));
    quick(() => readXlsx(cell('<rPh'.repeat(inflated)), 'b.xlsx'));
    quick(() => readXlsx(workbook(`<sheetData><row r="1"><c r="A1"><v${' '.repeat(inflated)}></c></row></sheetData>`), 'c.xlsx'));
    quick(() => readXlsx(workbook('<sheetData></sheetData>', { strings: `<sst>${'<si><t'.repeat(inflated / 4)}</sst>` }), 'd.xlsx'));
  });

  it('can\'t slow a row, or loop on a cell that never closes', () => {
    expect(() => readXlsx(workbook(`<sheetData><row r="1">${'<c r="A1">'.repeat(1_000)}</row></sheetData>`), 'e.xlsx')).toThrow('never closes');
    quick(() => readXlsx(workbook(`<sheetData>${'<row></row>'.repeat(140_000)}${' '.repeat(5_000_000)}</sheetData>`), 'f.xlsx'));
  });

  it('can\'t slow the merges', () => {
    quick(() => readXlsx(workbook(`<sheetData></sheetData><mergeCells>${'<mergeCell '.repeat(inflated / 4)}</mergeCells>`), 'g.xlsx'));
  });

  it('can\'t slow the parts read as a tree', () => {
    quick(() => readXlsx(workbook('<sheetData></sheetData>', { book: `<workbook>${'<?'.repeat(inflated / 2)}</workbook>` }), 'h.xlsx'));
    quick(() => readXlsx(workbook('<sheetData></sheetData>', { styles: `<styleSheet>${'<!--'.repeat(inflated / 4)}</styleSheet>` }), 'i.xlsx'));
  });

  it('can\'t pass a large stored part off as a small one', () => {
    const book = `<workbook>${' '.repeat(3 * 1024 * 1024)}</workbook>`;
    expect(() => readXlsx(zip({ 'xl/workbook.xml': book }, { declaredSize: 10 }), 'j.xlsx')).toThrow('larger than ZLens reads');
  });

  it('can\'t repeat one long string past what ZLens keeps', () => {
    const strings = `<sst><si><t>${'x'.repeat(1_000_000)}</t></si></sst>`;
    const row = `<row>${'<c t="s"><v>0</v></c>'.repeat(200)}</row>`;
    expect(() => readXlsx(workbook(`<sheetData>${row.repeat(1_000)}</sheetData>`, { strings }), 'k.xlsx')).toThrow('more text');
  });
});

describe('what an .xlsx says around its table', () => {
  const inline = (text: string) => `t="inlineStr"><is><t>${text}</t></is></c>`;
  const table = `<row r="4"><c r="A4" ${inline('Region')}<c r="B4" ${inline('Sales')}</row><row r="5"><c r="A5" ${inline('East')}<c r="B5"><v>1.5</v></c></row>`;

  it('takes every line of ExportHeaders as what the export says about itself', () => {
    const book = `<workbook xmlns:r="x"><sheets><sheet name="ExportHeaders" r:id="rId2"/><sheet name="Data" r:id="rId1"/></sheets></workbook>`;
    const parts = (lines: string[]) => zip({
      'xl/workbook.xml': book,
      'xl/_rels/workbook.xml.rels': `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>`,
      'xl/worksheets/sheet1.xml': `<worksheet><sheetData>${table}</sheetData></worksheet>`,
      'xl/worksheets/sheet2.xml': `<worksheet><sheetData>${lines.map((line, index) => `<row r="${index + 1}"><c r="A${index + 1}" ${inline(line)}</row>`).join('')}</sheetData></worksheet>`,
    });
    expect(readExport(parts(['Applied filters:', 'Region is East']), 'a.xlsx').appliedFilters).toBe('Region is East');
    expect(readExport(parts(['Angewendete Filter: Region ist Ost']), 'b.xlsx').appliedFilters).toBe('Angewendete Filter: Region ist Ost');
    expect(readExport(parts(['Exported data exceeded the allowed volume']), 'c.xlsx').cutShort).toContain('exceeded');
  });

  it('counts a hidden sheet as something unread', () => {
    const book = `<workbook xmlns:r="x"><sheets><sheet name="Data" r:id="rId1"/><sheet name="Old" state="hidden" r:id="rId2"/></sheets></workbook>`;
    const parsed = readExport(zip({
      'xl/workbook.xml': book,
      'xl/_rels/workbook.xml.rels': `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`,
      'xl/worksheets/sheet1.xml': `<worksheet><sheetData>${table}</sheetData></worksheet>`,
    }), 'c.xlsx');
    expect(parsed.unread).toEqual(['the hidden sheet Old']);
  });

  it('sets a title aside, and finds a table that starts a column in', () => {
    const titled = readExport(workbook(`<sheetData><row r="1"><c r="A1" ${inline('Sales by Region')}</row>${table}</sheetData>`), 'd.xlsx');
    expect(titled.headers).toEqual(['Region', 'Sales']);
    expect(titled.notes[0]).toContain('Sales by Region');
    const indented = readExport(workbook(`<sheetData><row r="2"><c r="B2" ${inline('Region')}<c r="C2" ${inline('Sales')}</row><row r="3"><c r="B3" ${inline('East')}<c r="C3"><v>1.5</v></c></row></sheetData>`), 'e.xlsx');
    expect(indented.headers).toEqual(['Region', 'Sales']);
    expect(indented.rows).toEqual([['East', '1.5']]);
    expect(indented.fullValues).toEqual({ Sales: 'number' });
  });

  it('gives each measure under Measure Values its own format', () => {
    const styles = `<styleSheet><cellXfs><xf numFmtId="0"/><xf numFmtId="10"/></cellXfs></styleSheet>`;
    const parsed = readExport(workbook(`<sheetData>
      <row r="1"><c r="A1" ${inline('Region')}<c r="B1" ${inline('Measure Names')}<c r="C1" ${inline('Measure Values')}</row>
      <row r="2"><c r="A2" ${inline('East')}<c r="B2" ${inline('Sales')}<c r="C2"><v>10</v></c></row>
      <row r="3"><c r="A3" ${inline('East')}<c r="B3" ${inline('Margin')}<c r="C3" s="1"><v>0.149</v></c></row>
    </sheetData>`, { styles }), 'f.xlsx');
    expect(parsed.fullValues).toEqual({ Sales: 'number', Margin: 'percent' });
  });

  it('allows a full value only a float\'s noise', () => {
    const parsed = readExport(workbook(`<sheetData><row r="1"><c r="A1" ${inline('Region')}<c r="B1" ${inline('Sales')}</row><row r="2"><c r="A2" ${inline('East')}<c r="B2"><v>1500000001</v></c></row></sheetData>`), 'g.xlsx');
    const plan = { keys: [{ header: 'Region', output: 'region', kind: 'text' as const }], numbers: [{ header: 'Sales', output: 'sales', name: 'sales' }], notCompared: [] };
    expect(compareExport(parsed, plan, [{ region: 'East', sales: 1_500_000_000 }]).numbers[0]!.verdict).toBe('differs');
    expect(compareExport(parsed, plan, [{ region: 'East', sales: 1_500_000_001.000000001 }]).numbers[0]!.verdict).toBe('matches');
  });
});

