import { crossed, type AutovacuumAction } from '../db/autovacuum'

const integer = new Intl.NumberFormat('en-US')

/** e.g. "autovacuum: analyzed orders", or "autovacuum: vacuumed and analyzed sales.events" outside public. */
export function actionTitle(action: AutovacuumAction) {
  const what = action.vacuumed ? (action.analyzed ? 'vacuumed and analyzed' : 'vacuumed') : 'analyzed'
  const table = action.schema === 'public' ? action.table : `${action.schema}.${action.table}`
  return `autovacuum: ${what} ${table}`
}

/** Why autovacuum acted: each counter that went over its threshold, e.g. "5,051 rows changed since the last analyze (threshold 5,050)". */
export function actionReasons(action: AutovacuumAction): string[] {
  const { deadRows, insertedRows, changedRows } = action.assessment
  const reasons: string[] = []
  if (crossed(deadRows)) {
    const dead = `${integer.format(deadRows.count)} dead ${deadRows.count === 1 ? 'row' : 'rows'}`
    reasons.push(`${dead} (threshold ${integer.format(deadRows.threshold)})`)
  }
  if (insertedRows && crossed(insertedRows)) {
    reasons.push(`${rows(insertedRows.count)} inserted since the last vacuum (threshold ${integer.format(insertedRows.threshold)})`)
  }
  if (crossed(changedRows)) {
    reasons.push(`${rows(changedRows.count)} changed since the last analyze (threshold ${integer.format(changedRows.threshold)})`)
  }
  return reasons
}

export function rows(count: number) {
  return `${integer.format(count)} ${count === 1 ? 'row' : 'rows'}`
}
