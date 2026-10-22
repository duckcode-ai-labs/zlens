import { useEffect, useState } from 'react';
import type { DashboardDriverDefinitionV1 } from '../../../api/client';
import { driverPeriodLabel } from '../driver-probe';

/**
 * Settings for a "Why did it move?" tile. The period, comparison and
 * dimensions are all the tile stores; every number is rerun from the
 * governed Dataset each time the page runs.
 */
export function DriverTileSettings({ driver, disabled, onChange }: {
  driver: DashboardDriverDefinitionV1;
  disabled: boolean;
  onChange: (driver: DashboardDriverDefinitionV1) => void;
}): JSX.Element {
  const [anchor, setAnchor] = useState(driver.anchor);
  const [dimensions, setDimensions] = useState(driver.dimensions.join(', '));
  useEffect(() => setAnchor(driver.anchor), [driver.anchor]);
  useEffect(() => setDimensions(driver.dimensions.join(', ')), [driver.dimensions]);
  const allDimensions = driver.dimensions.length === 1 && driver.dimensions[0] === '*';
  const commitDimensions = () => {
    const next = dimensions.split(',').map((entry) => entry.trim()).filter(Boolean).slice(0, 6);
    const value = next.length ? next : ['*'];
    if (value.join(',') !== driver.dimensions.join(',')) onChange({ ...driver, dimensions: value });
  };
  return <section className="inspector-driver" aria-label="Why did it move? settings">
    <label>Explains</label>
    <p className="field-help">{driver.measure.replace(/_/g, ' ')} in {driverPeriodLabel(driver.anchor, driver.grain)}, split by member.</p>
    <label htmlFor="driver-anchor">Period</label>
    <input id="driver-anchor" type="date" disabled={disabled} value={anchor} onChange={(event) => setAnchor(event.target.value)} onBlur={() => { if (anchor && anchor !== driver.anchor) onChange({ ...driver, anchor }); }} />
    <label htmlFor="driver-comparison">Compared with</label>
    <select id="driver-comparison" disabled={disabled} value={driver.comparison} onChange={(event) => onChange({ ...driver, comparison: event.target.value as DashboardDriverDefinitionV1['comparison'] })}>
      <option value="previous_period">The {driver.grain} before</option>
      <option value="previous_year">The same {driver.grain} last year</option>
    </select>
    <label htmlFor="driver-dimensions">Break down by</label>
    <input id="driver-dimensions" disabled={disabled} placeholder="All approved dimensions" value={allDimensions ? '' : dimensions} onChange={(event) => setDimensions(event.target.value)} onBlur={commitDimensions} />
    <small className="field-help">Field names, separated by commas (up to 6). Leave empty to use every approved dimension.</small>
  </section>;
}
