---
name: ux-design-review
description: Use when the user asks for a UX or design review of a Spark screen, flow, component, screenshot, mockup, or feature idea — critiquing what exists against usability heuristics, accessibility, cognitive load, and AI-product trust and control, or turning a planned feature into concrete design decisions. Not for code quality or correctness (use frontend-development or /code-review).
argument-hint: "[screenshot path | route or page name | component path | feature description]"
---

# UX design review

Judge the experience, not the code. The output should read like a senior designer's
review: the few issues that matter most, why each one hurts users, and the smallest
change that fixes it. The frameworks below are scaffolding for judgment, not a checklist
to recite. Skip any lens that has nothing to say, and report problems, not passes.

Target: `$ARGUMENTS`. If it is empty, ask what to review and whether the user wants a
critique or design guidance.

## Pick the mode

- **Critique** — something exists (a screen, route, component, screenshot, or mockup).
  Find what violates or risks violating the lenses below.
- **Design guidance** — a feature or flow is still being planned. Name the core user
  action, surface only the lenses that shape it, and turn each into a directive ("Do X"),
  not a musing ("consider whether X might…").

When both a visual and a written description exist, use both: the visual for execution,
the description for flow logic.

## Gather evidence first

Every finding should point at something you saw: a `file:line`, a region of a screenshot,
or a step in the flow. Keep what you observed separate from what you are inferring.

| Input | How to see it |
|---|---|
| Screenshot or mockup | Read the image file. |
| Component or page path | Read the TSX, plus the `@sharpen/components` it composes. Pages live in `apps/ui/src/pages/<Feature>/`; routes and the sidebar in `apps/ui/src/constants/nav.ts`. |
| Route or page name | Look at it running: the `run` skill or the Chrome tools against the local UI. If the dev backend is unreachable, `VITE_OFFLINE=true` renders scripted fixtures without auth. Capture loading, empty, and error states, not just the happy path. |
| Feature description or spec | Work from the text; ask only for context that would change the recommendation. |

Screenshots and static code can show visual accessibility risks, but cannot prove keyboard
access, screen-reader output, focus handling, or WCAG conformance. Mark those "verify in
implementation" rather than asserting them.

## Hold it to the house conventions

Spark already has a design system and written conventions. A finding that cites them is
stronger than generic advice, and a recommendation that contradicts them is wrong for
this repo. Check against:

- `.claude/rules/ui-forms-and-dialogs.md` — forms, dialogs, sidebar fields, "Add…" lists,
  which bordered container to use.
- `.claude/rules/ui-navigation.md` — page shell, `PageHeader`, detail-page shapes, the
  Sparky page and dock.
- `packages/sharpen-components/README.md` — what components and variants exist.
- The Quality Bar in the `frontend-development` skill — loading, error, and empty states;
  em dash for empty cells; create in a dialog, edit in a page or sidebar; Title Case
  action labels; design tokens only; dark mode via `data-theme`.

Recommend composing or extending `@sharpen/components` over one-off UI.

## Lenses

**Usability heuristics** apply to almost every review. The full 10, with what each looks
like here, are in [references/heuristics.md](references/heuristics.md). For a screenshot,
start with status (H1), consistency (H4), focus (H8), recognition (H6), and exits (H3).
For a written flow, start with error prevention (H5), language (H2), control (H3),
efficiency (H7), and help (H10).

**Cognitive load.** Mental effort spent on anything other than the task is where users
stall. Look for competing calls to action, labels users would not use, decisions the
product could default or infer, information carried between steps, and manual work the
product could do. Quick tests: what stands out when you squint, would a first-time user
know what to do in three seconds, and what breaks if an element is removed. Keep friction
that prevents irreversible or costly mistakes.

**Accessibility.** A short WCAG 2.1 A/AA pass focused on likely user impact: contrast,
color-only meaning, text size, visible focus, target size, keyboard reachability, labels
and errors wired to controls, status announcements, and modal focus handling.

**Visual craft.** For high-fidelity UI only, skip for wireframes and concepts. Hierarchy
from size, weight, and color rather than decoration; spacing on the 4/8 scale with tighter
gaps inside a group than between groups; one elevation language; every interactive state
designed (hover, focus-visible, active, disabled, loading, empty, error); motion of
120–250ms on transform and opacity that respects `prefers-reduced-motion`; real microcopy,
never placeholder text. Give concrete replacements using design tokens.

**AI product.** Spark is an AI product, so voice agents, workflows that call models, and
Sparky all get this lens: what the AI can change, send, spend, or reveal; whether its
active model, mode, sources, and autonomy are visible; whether users can preview, approve,
stop, undo, and verify; and whether AI content and actors are disclosed. Load
[references/ai-product.md](references/ai-product.md) whenever the target involves AI.

**Strategy.** When the problem itself is unclear, or the question is what to build or fix
first, recommend research or prioritization before UI changes. Load
[references/research-and-strategy.md](references/research-and-strategy.md).

## Output

Lead with a verdict, then keep it compact. Omit any section with nothing real in it.

```markdown
**Verdict:** Solid | Needs work | High risk — <one-line reason>

**Top issues**
1. <H5 Error prevention> <issue, with file:line or screen region> — <user or trust consequence>
2. …  (3–5 total, most severe first)

**Recommended changes**
1. <concrete change, naming the component, variant, or copy to use>
2. …

**Accessibility risks**
- <issue> (or "verify in implementation" for what static review can't prove)

**AI-specific risks**
- Scope: … / Trust: … / Control: … / Data: … / Cost: …

**Open questions** — only where the answer would change a recommendation.

**Next step** — the single most useful artifact, test, or decision.
```

Verdict meaning: **Solid** needs only targeted refinements; **Needs work** has issues that
will affect usability, trust, or conversion; **High risk** is likely to confuse, mislead,
or harm users without a redesign.

In design-guidance mode, replace "Top issues" with **Design decisions**: up to five
directives, each tagged with the lens that drives it.

This skill reviews and recommends. Do not edit code unless the user asks; offer to apply
the changes, and hand implementation to the `frontend-development` workflow.
