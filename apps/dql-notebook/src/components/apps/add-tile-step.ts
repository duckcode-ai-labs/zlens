import type { AppBlockRecommendation } from '../../api/client';
import { savedQueryNeedsFields } from './builder/app-data';

/**
 * What "+ Add tile" does (V3: on an App whose data was saved queries without fields, two clicks did nothing a
 * person could see). Every click does something visible:
 * - `build`: a new tile starts on the page, and the data's fields are listed to click;
 * - `read-fields`: the saved query is chosen and its columns are read as fields ("Reading the columns of …");
 * - `add-as-is`: the saved query is chosen, and the Data pane offers it as a Table, Chart or KPI;
 * - `choose-data`: the App has several pieces of data and none is chosen: the list of this App's data opens;
 * - `add-data`: the App has no data yet: Add data opens.
 */
export type AddTileStep =
  | { kind: 'build'; source: AppBlockRecommendation }
  | { kind: 'read-fields'; source: AppBlockRecommendation }
  | { kind: 'add-as-is'; source: AppBlockRecommendation }
  | { kind: 'choose-data' }
  | { kind: 'add-data' };

export function addTileStep(input: {
  /** The App's data (its sources). */
  appData: AppBlockRecommendation[];
  /** The data with fields a new tile would be built on, when there is one. */
  fieldsSource: AppBlockRecommendation | null;
  /** The data chosen in the Data pane, when any. */
  chosen: AppBlockRecommendation | null;
  /** Field tiles are on (`features.datasets`). */
  datasetTilesEnabled: boolean;
  /** Saved queries whose columns could not be read this visit (source id → failed). */
  fieldsReadFailed?: (source: AppBlockRecommendation) => boolean;
}): AddTileStep {
  if (input.datasetTilesEnabled && input.fieldsSource) return { kind: 'build', source: input.fieldsSource };
  if (!input.appData.length) return { kind: 'add-data' };
  const source = input.chosen ?? (input.appData.length === 1 ? input.appData[0]! : null);
  if (!source) return { kind: 'choose-data' };
  if (input.datasetTilesEnabled && savedQueryNeedsFields(source) && !input.fieldsReadFailed?.(source)) return { kind: 'read-fields', source };
  return { kind: 'add-as-is', source };
}
