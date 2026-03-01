## Error Handling

- **Tool call failures**: If `save_issue` returns an error, read the error message — it contains valid states/intents and a Recovery action. Retry with corrected parameters.
- **State gate blocks**: Hooks enforce valid state transitions. Check the current workflow state and re-evaluate.
- **Postcondition failures**: Stop hooks verify expected outputs. Satisfy the requirement before retrying.
