# The 10 usability heuristics

Cite a finding by number and short name, e.g. "H3 Control". Raise a heuristic only when it
exposes a real issue or shapes a design decision.

**H1 Visibility of system status.** Users always know what the system is doing: loading,
saving, publishing, running, failed, done. In Spark, watch for mutations with no pending
state, long jobs with no progress, and success that is only implied.

**H2 Match with the real world.** The user's words, not internal ones. Contact-center
admins say "call", "agent", and "queue", not node type IDs, enum values, or service names.
Icons and flows follow mental models users already hold.

**H3 User control and freedom.** Clear cancel, back, close, and undo. A user who wanders
into a dialog, a wizard step, or an edit by mistake can leave without losing work or
committing anything.

**H4 Consistency and standards.** The same component behaves the same way everywhere, and
platform conventions win over invention. Here that means the `@sharpen/components`
patterns and the conventions in `.claude/rules/ui-forms-and-dialogs.md` and
`ui-navigation.md`.

**H5 Error prevention.** Constraints, good defaults, and inline validation before submit.
Confirmation for destructive or live-affecting actions, such as delete, publish, or
reassigning a phone number, scaled to the stakes.

**H6 Recognition rather than recall.** Options, labels, prior inputs, and context are
visible where they are needed. Users should not have to remember an ID, a variable name,
or a value from a previous screen.

**H7 Flexibility and efficiency.** Faster paths for repeat and expert use, such as
keyboard access, bulk actions, search and filter, and duplicate, without cluttering the
path for a new user.

**H8 Aesthetic and minimalist design.** Every element competes for attention. Visual
hierarchy should match task hierarchy, with one primary action per view.

**H9 Recognize, diagnose, and recover from errors.** Plain language, the specific
problem, and a way forward. No raw status codes, stack traces, or "Something went wrong"
with no next step. A field-level rejection should land on the field, and an error inside
a collapsed section should be reachable from the message.

**H10 Help and documentation.** Ideally unnecessary. When it is needed, it is contextual,
such as a field description, an inline hint, or a link to the relevant
`docs.spark.sharpencx.com` page, and it is phrased as action rather than a wall of text.
