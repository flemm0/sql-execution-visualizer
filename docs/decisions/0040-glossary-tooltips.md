# 0040: Glossary tooltips: where they appear, captions left plain, popovers for access

- **Status:** Accepted
- **Date:** 2026-10-13

## Context
[ADR 0003](0003-audience-and-detail.md) promises real Postgres terms throughout, each with a glossary tooltip. We had to decide which text gets marked, what to do with the generated step captions, and how a tooltip works for keyboard and screen-reader users without breaking the text around it. The accent colors are reserved for their meanings ([ADR 0016](0016-visual-identity.md)), so a marked term can't be colored.

## Decision
- **One glossary:** every definition lives in `src/glossary/glossary.ts`, a plain record from term to definition. Each definition is one or two sentences, written for developers who write SQL, accurate to Postgres 18, and uses the captions' words. Plan node types and EXPLAIN fields use Postgres's spelling (`Index Cond`); the other terms are lower case (`shared buffers`).
- **One component:** `<Term term="…">` marks a term with a dotted underline in a neutral color. The text keeps the color of the text around it. The term takes focus with Tab. Its definition shows while the pointer is over the term (or over the definition itself) or while the term has focus. Escape hides it. The definition fades in, and with reduced motion on it appears at once.
- **Where terms are marked:**
  - **Plan pane:** node types in headings, every EXPLAIN field label, `est.`, buffer `hit` / `read`, and what each replay check compares.
  - **Visualization:** the node line, the zone headings (Index, Shared buffers, Heap), the index summary (`search`, `leaf`, `marked dead`), buffer `hits` / `reads`, `all-visible`, `visible` and `bitmap`.
  - **Page browser:** `heap page`, `line pointers`, `visible`, `ctid`, `root` / `leaf` / `level N`, and `entries` / `downlinks`.
  - **Schema details:** heap pages, the planner estimate, B-tree levels, autovacuum, vacuum, analyze and dead rows.
  - **Toolbar:** Autovacuum, and "cache" in Empty cache.
- **Not marked:**
  - **Captions** stay plain text. A caption changes with every step, up to 60 times a second, inside a live region. A focusable term in it would vanish from under the keyboard focus, and its tooltip would close mid-read. Marking the first occurrence per caption would mean either matching terms in generated sentences (fragile: "page" is in nearly every caption) or making the player return marked-up segments (a restructure of shared code). Every term a caption uses is marked nearby, in the zone headings and summary lines.
  - **Inside the B-tree SVG:** it is one image to screen readers (`role="img"`), so focusable terms inside it would be hidden from them. The same terms are marked in the line above it and in the page browser.
  - **Repeated per-row text,** such as "not visible" or "dead" on each row, is not marked. The same term is marked once in the line above.
- **Accessibility:** the term is a focusable `<span>` whose `aria-describedby` points at its definition (`role="tooltip"`). The definition is always in the page, hidden when closed, so screen readers read it as the term's description. It is a `popover="manual"` element rendered into `<body>` through a React portal. The popover puts it in the browser's top layer, so no pane's scrolling or edges clip it. The portal keeps its text out of the surrounding text (a checkbox's name, a line the tests read). A click on a term doesn't reach a surrounding `<label>`, so the term can sit in a checkbox's label without toggling it. The checkbox's own `title` still explains what the setting does.

## Consequences
- The wording is reviewed in one file. A Vitest test checks that every term a component marks has a definition, as do every EXPLAIN field the plan shows and every node type the replay animates, plus Sort and Limit.
- More Tab stops in the plan pane, one per marked term.
- Captions don't link to definitions. A learner who wants a word from a caption finds it in the zone next to the caption.
- Popovers need Chrome 114, Firefox 125 or Safari 17, all older than the "current desktop" browsers we support.

## Alternatives considered
- **Native `title` attributes:** no keyboard access, a long delay, and the browser's own styling.
- **Absolutely positioned tooltips inside the term:** clipped by scrolling panes, and their text becomes part of the surrounding text.
- **Marking terms inside captions** (all occurrences, or the first per caption): rejected for the reasons above. It can be revisited if captions become structured.
- **Colored or solid underlines:** would compete with the accent colors' meanings.
