# Board document format

A board is one Markdown document. The server places every frame and element; write no coordinates and no sizes.

| Markdown                                                 | On the board                                                     |
| -------------------------------------------------------- | ---------------------------------------------------------------- |
| `# Name` (first level-1 heading)                         | board name                                                       |
| `## Heading`                                             | one frame, in document order                                     |
| text before the first `##`                               | an overview frame named after the board                          |
| paragraphs, `###` sub-headings, `> quotes`               | one text block at the top of the frame                           |
| bullet or numbered list                                  | one sticky note per item; nested items go into the parent's note |
| ` ```mermaid ` block with `flowchart TD` (or LR, BT, RL) | shapes and connectors, laid out automatically                    |
| ` ```mermaid ` block with `wardley-beta`                 | a Wardley map                                                    |
| tables, images, other code blocks, HTML                  | not drawn; validation names the line                             |

Bold, italic and https links in text are kept; http links lose their link and keep only their text. Frames are placed side by side and sized to their content. Give every frame its own title.

Keep a sticky note under 140 characters; Miro shrinks the font of longer ones. Close every code block with ```; an open one swallows the rest of the document.

## Theme: slides

Front matter at the very top chooses the look. Without `theme` the board looks as described above.

```markdown
---
theme: slides
title: Clear code reviews
kicker: FOCUS TOPIC
subtitle: What makes feedback helpful
tagline: A one-hour session
byline: 1 January 2030, Example Team
---
```

With `theme: slides` every frame is a slide of the same fixed size (6078 x 4332); the content never makes it grow.

| Markdown                                           | On the slide                                                                                            |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `title`, `kicker`, `subtitle`, `tagline`, `byline` | a white title slide first; only `title` (or `# Name`) is needed                                         |
| `## Heading`                                       | a black slide; the heading top left in light violet                                                     |
| paragraphs, `###`, quotes                          | white text below the heading                                                                            |
| a `> quote` as the only block of a frame           | a statement slide: one large centred sentence, no heading                                               |
| list `- item`                                      | dark cards with a white border, three per row                                                           |
| task list `- [ ] item` (or `- [x]`)                | yellow sticky notes: templates for participants to copy                                                 |
| ` ```mermaid ` flowchart                           | dark boxes with white borders and text, white arrows; `classDef` colours stay; scaled to the free space |
| ` ```mermaid ` wardley-beta                        | the map in its own colours on a white panel                                                             |

Write `- [ ]` only for what participants should fill in, such as "Your sticky: …"; everything else in a list becomes a card. A list may mix both; each run of cards or sticky notes stays in document order.

Every content slide gets the footer logos the server is configured with. A slide whose content does not fit gets a layout warning "slide … is too full" on its heading line: split it into two frames with a second `## heading`. Do not shrink or cut the content to make it fit. On the title slide, a text that runs into the next one or off the slide gets a warning as well; shorten it or move words into `subtitle` or `tagline`.

## Flowchart

The official Mermaid parser reads the block.

- Node shapes: `A[box]`, `A(rounded)`, `A([stadium])`, `A{decision}`, `A((circle))`, `A[(database)]`, `A{{hexagon}}`, `A[/lean/]`, `A[/trapezoid\]`.
- Edges: `-->`, `---` (no arrow), `-.->` (dotted), `==>` (thick), `<-->` (both ends), labels with `-->|text|`.
- `subgraph Name ... end` draws a titled box around its nodes.
- `classDef name fill:#d3f9d8,stroke:#2b8a3e,color:#212529` with `class A name`, or `style A fill:#...`: hex colours only; a name such as `green` is ignored.
- Keep node labels under 80 characters; the box grows with the text.
- `click` is ignored: shapes on the board get no links.

## Wardley map

The official Mermaid parser for `wardley-beta` reads the block. Coordinates are `[visibility, evolution]`, both from 0 to 1; visibility 1 is at the top.

```text
wardley-beta
title Tea shop
anchor Customer [0.95, 0.60]
component Cup of tea [0.80, 0.60]
component Kettle [0.40, 0.70]
Customer -> Cup of tea
Cup of tea -> Kettle ; needs
evolve Kettle 0.85
pipeline Kettle {
  component Gas kettle [0.55]
  component Electric kettle [0.75]
}
note "commoditising" [0.30, 0.80]
```

- Names with spaces need no quotes; names with `:`, `,`, `?` or umlauts do: `component "Teams: Zweck" [0.5, 0.4]`.
- Every coordinate must lie between 0 and 1; a larger value is an error.
- `pipeline Parent { component Part [evolution] }` draws a box with its parts on the parent's line, and the parent on top of the box. Mermaid has no group statement; use pipelines for bands and groups.
- Also drawn: `note`, `annotation 1,[v, e] "text"` with `annotations [v, e]`, `accelerator` and `deaccelerator`, `evolution Genesis -> Custom@0.4 -> Product@0.7 -> Commodity@1.0`, `size [width, height]`, `inertia`.
- Colours: front matter in the block, `config.themeVariables.wardley` (componentFill, componentStroke, linkStroke, evolutionStroke, axisColor, ...), hex only.
- `(build)`, `(buy)`, `(outsource)` and `(market)` are accepted but not drawn.
- `evolve` on a part of a pipeline is not drawn, as in Mermaid; write a note instead.

## Rules

- Invented examples only: no real people, customers or company names.
- Validate, preview, show the preview to the user, build only after the user's yes.
