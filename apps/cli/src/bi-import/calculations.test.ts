import { describe, expect, it } from 'vitest';
import { classifyCalculations, formulaWithoutComments, type BiCalculation } from './calculations.js';

// As the workbook reader gives them: `references` names the calculations a formula uses.
const tableau = (name: string, formula: string, owner = 'Orders', references: string[] = []): BiCalculation => ({ name, formula, language: 'tableau', role: 'measure', owner, sourcePath: 'sales.twb', references });
const dax = (name: string, formula: string, role: BiCalculation['role'] = 'measure'): BiCalculation => ({ name, formula, language: 'dax', role, owner: 'Measures', sourcePath: 'sales.pbit' });
const kinds = (calculations: BiCalculation[]) => Object.fromEntries(classifyCalculations(calculations).map((calculation) => [calculation.name, calculation.kind]));

describe('Tableau calculated fields', () => {
  it('sorts one aggregate, an aggregate of a condition, combined aggregates and row values', () => {
    expect(kinds([
      tableau('Sales', 'SUM([Sales])'),
      tableau('Customers', 'COUNTD([Customer ID])'),
      tableau('Line total', 'SUM([Price] * [Quantity])'),
      tableau('East sales', 'SUM(IF [Region] = "East" THEN [Sales] END)'),
      tableau('Returned', 'SUM(IIF([Returned], [Sales], 0))'),
      tableau('Profit ratio', 'SUM([Profit]) / SUM([Sales])'),
      tableau('Margin', 'ZN(SUM([Profit])) / ZN(SUM([Sales])) * 100'),
      tableau('Days to ship', 'DATEDIFF(\'day\', [Order Date], [Ship Date])'),
      tableau('Version', "'02.02'"),
    ])).toEqual({
      Sales: 'simple', Customers: 'simple', 'Line total': 'simple',
      'East sales': 'filtered', Returned: 'filtered',
      'Profit ratio': 'ratio', Margin: 'ratio',
      'Days to ship': 'row-level', Version: 'row-level',
    });
  });

  it('calls level of detail, table calculations, conditions on totals and user functions advanced, with why', () => {
    const classified = classifyCalculations([
      tableau('Customer first order', '{FIXED [Customer ID]: MIN([Order Date])}'),
      tableau('Running sales', 'RUNNING_SUM(SUM([Sales]))'),
      tableau('Share', 'SUM([Sales]) / TOTAL(SUM([Sales]))'),
      tableau('Big month', 'IF SUM([Sales]) > 1000 THEN "Big" ELSE "Small" END'),
      tableau('Mine', 'USERNAME() = [Owner]'),
    ]);
    expect(classified.map((calculation) => calculation.kind)).toEqual(['advanced', 'advanced', 'advanced', 'advanced', 'advanced']);
    expect(classified[0]!.reason).toMatch(/level of detail/);
    expect(classified[1]!.reason).toMatch(/table calculation/);
    expect(classified[3]!.reason).toMatch(/condition on aggregated values/);
    expect(classified[4]!.reason).toMatch(/who is viewing/);
  });

  it('ignores names inside comments and strings, and takes the harder kind of a calculation it builds on', () => {
    expect(kinds([
      tableau('Commented', '// was RUNNING_SUM(SUM([Sales]))\nSUM([Sales])'),
      tableau('Quoted', 'IF [Note] = "WINDOW_SUM(" THEN 1 ELSE 0 END'),
      tableau('First order', '{FIXED [Customer ID]: MIN([Order Date])}'),
      tableau('Days since first order', 'DATEDIFF(\'day\', [First order], [Order Date])', 'Orders', ['First order']),
      tableau('Profit ratio', 'SUM([Profit]) / SUM([Sales])'),
      tableau('Profit ratio %', '[Profit ratio] * 100', 'Orders', ['Profit ratio']),
    ])).toEqual({
      Commented: 'simple', Quoted: 'row-level',
      'First order': 'advanced', 'Days since first order': 'advanced',
      'Profit ratio': 'ratio', 'Profit ratio %': 'ratio',
    });
  });

  it('without the reader\'s references, a [Name] that matches a calculation counts', () => {
    const loose = (name: string, formula: string): BiCalculation => ({ name, formula, language: 'tableau', role: 'measure', owner: 'Orders', sourcePath: 'sales.twb' });
    expect(kinds([loose('First order', '{FIXED [Customer]: MIN([Date])}'), loose('Age', 'DATEDIFF(\'day\', [First order], TODAY())')])).toEqual({ 'First order': 'advanced', Age: 'advanced' });
  });

  it('looks references up within one data source only', () => {
    expect(kinds([
      tableau('Rank', 'RANK(SUM([Sales]))', 'Orders'),
      tableau('Uses rank', '[Rank] + 1', 'Returns', ['Rank']),
    ])).toEqual({ Rank: 'advanced', 'Uses rank': 'row-level' });
  });
});

describe('Power BI DAX', () => {
  it('sorts measures: one aggregate, CALCULATE with column conditions, DIVIDE and arithmetic', () => {
    expect(kinds([
      dax('Total Sales', 'SUM(Sales[Amount])'),
      dax('Orders', 'COUNTROWS(Sales)'),
      dax('Customers', "DISTINCTCOUNT('Sales Lines'[Customer Key])"),
      dax('Paid Sales', 'CALCULATE(SUM(Sales[Amount]), Sales[Status] = "paid")'),
      dax('East Paid', 'CALCULATE([Total Sales], Region[Name] = "East", Sales[Status] IN {"paid", "refunded"})'),
      dax('Average Order', 'DIVIDE([Total Sales], [Orders])'),
      dax('Net', '[Total Sales] - SUM(Sales[Refund])'),
      dax('Sales Copy', '[Total Sales]'),
    ])).toEqual({
      'Total Sales': 'simple', Orders: 'simple', Customers: 'simple',
      'Paid Sales': 'filtered', 'East Paid': 'filtered',
      'Average Order': 'ratio', Net: 'ratio', 'Sales Copy': 'simple',
    });
  });

  it('calls time intelligence, iterators, filter changes, conditions and variables advanced, and so is a measure built on one', () => {
    const classified = classifyCalculations([
      dax('Total Sales', 'SUM(Sales[Amount])'),
      dax('Sales YTD', 'TOTALYTD([Total Sales], Dates[Date])'),
      dax('Line Total', 'SUMX(Sales, Sales[Qty] * Sales[Price])'),
      dax('All Regions', 'CALCULATE([Total Sales], ALL(Region))'),
      dax('Filtered', 'CALCULATE([Total Sales], FILTER(Sales, Sales[Amount] > 100))'),
      dax('Flag', 'IF([Total Sales] > 0, 1, 0)'),
      dax('With Var', 'VAR s = [Total Sales] RETURN s * 2'),
      dax('YTD Share', 'DIVIDE([Sales YTD], [Total Sales])'),
    ]);
    const byName = Object.fromEntries(classified.map((calculation) => [calculation.name, calculation]));
    for (const name of ['Sales YTD', 'Line Total', 'All Regions', 'Filtered', 'Flag', 'With Var', 'YTD Share']) expect(byName[name]!.kind, name).toBe('advanced');
    expect(byName['Sales YTD']!.reason).toMatch(/Time intelligence/);
    expect(byName['Line Total']!.reason).toMatch(/iterator/);
    expect(byName['YTD Share']!.reason).toBe('Builds on Sales YTD, which is advanced.');
  });

  it('sorts calculated columns as row values unless they aggregate, and calculated tables as advanced', () => {
    expect(kinds([
      dax('Margin', 'Sales[Price] - Sales[Cost]', 'column'),
      dax('Region Name', 'RELATED(Region[Name])', 'column'),
      dax('Customer Total', 'CALCULATE(SUM(Sales[Amount]))', 'column'),
      dax('Top Customers', 'TOPN(10, Customers, [Total Sales])', 'table'),
    ])).toEqual({ Margin: 'row-level', 'Region Name': 'row-level', 'Customer Total': 'advanced', 'Top Customers': 'advanced' });
  });

  it('ignores comments and text when reading a formula', () => {
    expect(kinds([dax('Sales', '-- was TOTALYTD(...)\nSUM(Sales[Amount]) // "SUMX("')])).toEqual({ Sales: 'simple' });
    expect(formulaWithoutComments('// note\nSUM([Sales]) /* old */', 'tableau')).toBe('SUM([Sales])');
  });
});
