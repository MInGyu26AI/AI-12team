# Case package — SyncUp for Team

133 cases your agent should handle differently from routine inquiries, and 164 inputs for asking your agent about them.

## Files

| File | For | Contents |
|---|---|---|
| `cases.csv` | Reviewers | 133 cases: category, title, summary, situation, difference from routine inquiries, related documents (file · section · passage) |
| `agent_questions.csv` | Your agent | 164 inputs to send to your agent: the 133 cases and 31 other phrasings of the same problems |

An input whose case ID has one more number, such as `C-012-1`, is another phrasing of the same problem as `C-012`.

## Steps

1. **Before**: Send each input in `agent_questions.csv` to your agent in a new conversation, and keep the answers.
2. **Review and update**: In `cases.csv`, read each situation and its related documents and decide how your agent should respond. Put what you decide into the materials your agent reads (documents, FAQs, business data).
3. **After**: Send the same inputs the same way again and compare the answers with step 1.

## Please note

- Send your agent only the inputs in `agent_questions.csv`. If `cases.csv`, especially the related documents, goes into your agent's materials, the comparison can't be trusted.
- Between steps 1 and 3, change only the materials and keep the agent's model, instructions and tool settings as they are. Then a changed answer shows the effect of the updated materials.
- This package has no correct answers or recommended responses. You decide how your agent should respond.

## Opening the files

The CSV files open directly in Excel. For long cells, widen the column or turn on Wrap Text.
