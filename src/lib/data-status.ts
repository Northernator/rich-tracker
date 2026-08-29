/**
 * Data provenance status.
 *
 * Set to 'verified' only after a loader has loaded rows with real source_ids
 * (not 'synthetic') and populated the data/ directory with raw captures.
 * While 'unverified', the UI banner warns every visitor that the figures
 * are placeholders and should not be cited.
 */
export const DATA_STATUS = 'unverified' as const;
