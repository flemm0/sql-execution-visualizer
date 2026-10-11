# 0030: Tab indents and accepts completions; columns complete without their table

- **Status:** Accepted
- **Date:** 2026-10-11

## Context
The SQL editor uses CodeMirror's `basicSetup`. It leaves Tab unbound on purpose, so a keyboard user can tab past the editor instead of getting stuck in it ([CodeMirror's guidance](https://codemirror.net/examples/tab/)). In practice learners pressed Tab to indent and got nothing (issue #15).

Completion worked for keywords, tables, and `table.` / `alias.` columns, but `@codemirror/lang-sql` never offers a column on its own: typing `WHERE stat` offered the keyword STATE and not the column `status`. So completion felt switched off exactly where SQL is written most (issue #14).

## Decision
- **Tab accepts an open suggestion; otherwise it indents** the line or selection, and Shift+Tab dedents (`acceptCompletion`, then `indentWithTab`). Enter still accepts, as before.
- **Leaving the editor by keyboard is Esc, then Tab**, CodeMirror's built-in escape hatch. [UX.md](../UX.md#running-statements) says so.
- **A second completion source offers bare column names**: the columns of the catalog tables the statement under the cursor names, ranked above keywords. A table counts as named when its name appears as a word in the statement (from `splitStatements`), so it works for `FROM`, `JOIN`, `UPDATE` and for a select list typed before its `FROM`. A column several tables share is offered once, with those tables listed beside it. It stays out of strings, comments and quoted identifiers, and after a `.`, where the SQL support's own qualified completion applies.

## Consequences
- Tab does what an editor user expects, at the cost of one extra key (Esc) to leave the editor.
- Every name offered comes from the live catalog, so tables created in the sandbox complete at once.
- Matching tables by word is approximate: a column alias or a word that happens to equal a table name brings that table's columns in too. That adds suggestions; it never hides one.
- CodeMirror ignores Tab and Enter for 75 ms after the suggestions open (`interactionDelay`), so a fast Tab right after a pop-up appears indents instead of accepting. People don't notice; the Playwright tests wait it out.

## Alternatives considered
- **Keep Tab unbound**: the most accessible default, but the editor is the app's main input and learners expect Tab to indent.
- **Parse FROM/JOIN with the SQL syntax tree** to find exactly which tables (and aliases) are in scope: more precise, but much more code for an editor hint, and it breaks on half-typed statements, which is when completion is used.
- **Offer every column of every table**: no parsing at all, but with dozens of tables the list drowns in names from tables the query doesn't touch.
