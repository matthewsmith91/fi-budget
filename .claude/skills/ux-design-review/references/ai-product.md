# AI product lens

AI features need every normal UX check plus scope, trust, control, and accountability.
Start with five questions:

- What is the AI acting on?
- What can it change, send, delete, spend, remember, or reveal?
- What is the worst case if it is wrong, and who bears it: the admin, or their callers?
- Can the user understand, steer, stop, undo, and verify it?
- Is it clearly disclosed as AI, to the admin and to the end customer?

In Spark this covers voice agents (prompts, tools, transfers, what callers hear), workflows
with model or agent nodes, Sparky's chat and the writes it proposes through approval cards,
knowledge bases, and Insights summaries.

## Inputs

Match the input pattern to the task.

| User need | Pattern |
|---|---|
| Explore freely | Open input |
| Repeat a structured task | Template or fill-in-the-blanks |
| Fill many fields or records | Auto-fill with preview |
| Edit selected content | Inline action on the selection |
| Try again | Regenerate, keeping prior versions recoverable |
| Change structure, style, or length | Restructure, restyle, expand, or summarize actions |
| Run a multi-step job | Chained action with visible steps |

In every pattern, make scope explicit before running, preview before committing, keep undo
or version history, mark AI-generated content until it is accepted, and show cost for
bulk, long-running, or chained work.

## Wayfinding

A blank prompt box is rarely enough. Prefer specific starting actions over "Ask anything",
suggestions tied to the current screen, examples of good outcomes, templates for complex
repeatable setups, and follow-ups after a result to refine or act on it. Contextual
guidance beats a generic onboarding tour.

## Tuners

Tuners let users shape behavior without prompt engineering: attachments and knowledge
sources, connectors to live systems, source filters, model choice, modes or presets,
advanced parameters for those who need them, and voice and tone settings.

**Active state must always be visible.** A hidden model, mode, knowledge source, voice, or
autonomy level erodes trust and makes failures impossible to diagnose.

## Governors

Keep users meaningfully in control as autonomy grows. Use stronger governors for actions
that are expensive, irreversible, public, customer-facing, or security-sensitive.

- **Action plan** — show the intended steps before running them.
- **Verification** — require approval before risky actions; Sparky's approval cards are
  this pattern, so check that each card says exactly what will change.
- **Controls** — stop, pause, resume, or cancel.
- **Cost estimate** — credits, minutes, or money before committing.
- **Draft or sample run** — a cheap or small-subset preview before the real run, such as
  testing an agent before publishing it.
- **Citations** — connect claims to source material.
- **Visible execution** — plan, current step, tool calls, and evidence.
- **Memory controls** — show what is remembered, and allow edit, delete, or off.
- **Branches and versions** — explore without overwriting what is live.

Calibrate the friction. For high-stakes, infrequent actions, use strong confirmation. For
low-stakes, frequent ones, use passive indicators plus undo. For high-stakes, frequent
ones, use rules, preferences, and configurable approval.

## Trust builders

The aim is calibrated trust, neither over- nor under-trust.

- **Caveats** — specific limits shown at the moment of decision, not boilerplate.
- **Consent** — explicit permission for recording, analysis, training, or sharing,
  especially for end callers.
- **Data ownership** — retention, deletion, and export controls that are easy to find.
- **Disclosure** — label AI actors, AI actions, and AI-generated content.
- **Footprints** — logged, viewable traces of prompts, sources, models, approvals, costs,
  and edits. Transcripts and the audit log are where Spark keeps these.

Disclaimers alone are not enough. Pair each warning with evidence, a control, or a way to
recover.

## Identity

The AI's name, avatar, color, icons, and personality should set accurate expectations:
recognizably AI, honest about capability, with state communicated without implying human
competence, AI accents that are accessible and consistent, and a tone that serves the task
without over-validating.
