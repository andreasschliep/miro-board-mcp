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

Bold, italic and https links in text are kept. Frames are placed side by side and sized to their content.

## Flowchart

The official Mermaid parser reads the block.

- Node shapes: `A[box]`, `A(rounded)`, `A([stadium])`, `A{decision}`, `A((circle))`, `A[(database)]`, `A{{hexagon}}`, `A[/lean/]`, `A[/trapezoid\]`.
- Edges: `-->`, `---` (no arrow), `-.->` (dotted), `==>` (thick), `<-->` (both ends), labels with `-->|text|`.
- `subgraph Name ... end` draws a titled box around its nodes.
- `classDef name fill:#d3f9d8,stroke:#2b8a3e,color:#212529` with `class A name`, or `style A fill:#...`: hex colours only.

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
- `pipeline Parent { component Part [evolution] }` draws a box with its parts under the parent. Mermaid has no group statement; use pipelines for bands and groups.
- Also drawn: `note`, `annotation 1,[v, e] "text"` with `annotations [v, e]`, `accelerator` and `deaccelerator`, `evolution Genesis -> Custom@0.4 -> Product@0.7 -> Commodity@1.0`, `size [width, height]`, `inertia`.
- Colours: front matter in the block, `config.themeVariables.wardley` (componentFill, componentStroke, linkStroke, evolutionStroke, axisColor, ...), hex only.
- `(build)`, `(buy)`, `(outsource)` and `(market)` are accepted but not drawn.

## Rules

- Invented examples only: no real people, customers or company names.
- Validate, preview, show the preview to the user, build only after the user's yes.
