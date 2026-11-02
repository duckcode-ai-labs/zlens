import { DqlApiError } from '../../api/client';

/** The host refused the request (its row policy, credentials, or connection choice): a 403, as /api/query answers one. */
export function isHostRefusal(error: unknown): boolean {
  return error instanceof DqlApiError && (error.status === 403 || error.code === 'POLICY_DENIED');
}

/** What a draft's run left behind: the refuser's own sentence when the host refused it, otherwise the preview failure. */
export interface ImportRunError {
  message: string;
  /** The host refused the run: its sentence is the whole story, the draft is not at fault, and no repair is offered. */
  refused: boolean;
}

export function importRunError(error: unknown, fallback = 'Candidate run failed.'): ImportRunError {
  const message = error instanceof Error && error.message.trim() ? error.message : fallback;
  return { message, refused: isHostRefusal(error) };
}
