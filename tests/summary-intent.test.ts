/**
 * The chat answers from the stored Patient Summary, or offers to save an
 * answer as a new one, only for an explicit summary request. A question
 * that merely mentions the summary gets an ordinary answer.
 */
import { describe, it, expect } from 'vitest';
import { summaryIntent } from '../src/utils/summaryIntent';

describe('explicit summary requests', () => {
  it('asking to see it', () => {
    for (const t of ['Show my patient summary', 'show me my summary.', 'Please display the patient summary', 'What’s in my patient summary?',
      "what is in my summary", 'What does my patient summary say?', 'My patient summary', 'patient summary', 'Can you open my current patient summary please']) {
      expect(summaryIntent(t), t).toBe('show');
    }
  });

  it('asking to write or update it', () => {
    for (const t of ['Update my patient summary', 'write a new patient summary', 'Please regenerate my summary!', 'Create an updated patient summary']) {
      expect(summaryIntent(t), t).toBe('write');
    }
  });

  it('anything else is an ordinary question', () => {
    for (const t of [
      'What does this document say? Should anything in my Patient Summary change?',
      'Is my patient summary missing my allergy to penicillin?',
      'Summarize my last visit', 'What is my A1c?', 'Does the report change my summary?',
      'Show my patient summary and then list my medications', ''
    ]) {
      expect(summaryIntent(t), t).toBeNull();
    }
  });
});
