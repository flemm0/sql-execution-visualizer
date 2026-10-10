/**
 * Thrown by a replayer that meets something it can't replay yet, with the
 * sentence the plan pane shows, e.g. "Animation isn’t available yet for skip scans."
 * The replay then reports the query as unsupported rather than failed.
 */
export class Unsupported extends Error {}
