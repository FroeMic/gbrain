import { expect } from 'bun:test';
import type { BrainCommandCase } from '../brain-command-contract.ts';

export const identityCommandCase: BrainCommandCase = {
  name: 'brain identity returns runtime metadata',
  operation: 'get_brain_identity',
  input: {},
  classification: {
    deterministic: true,
    destructive: false,
    fileDependent: false,
    modelDependent: false,
  },
  verify: ({ outcome }) => {
    expect(outcome).toMatchObject({
      status: 'success',
      result: { version: expect.any(String), engine: expect.any(String) },
    });
  },
};

export const addTagCommandCase: BrainCommandCase = {
  name: 'tag write completes once',
  operation: 'add_tag',
  input: { slug: 'people/alice-example', tag: 'parity' },
  classification: {
    deterministic: true,
    destructive: false,
    fileDependent: false,
    modelDependent: false,
  },
  verify: ({ outcome }) => {
    expect(outcome).toEqual({ status: 'success', result: { status: 'ok' } });
  },
};
