/** The code samples in README.md, in order, with the results the README claims. */
import { expect, it } from 'vitest';
import { TextDoc, type ChangeEvent } from '../src/index.ts';

it('README samples behave as documented', () => {
  // --- Using it
  const ada = new TextDoc({ replicaId: 'ada' });
  const ben = new TextDoc({ replicaId: 'ben' });

  ben.apply(ada.insert(0, 'Shopping:\n'));

  const fromAda = ada.insert(10, 'eggs\n');
  const fromBen = ben.insert(10, 'bread\n');

  ada.apply(fromBen);
  ben.apply(fromAda);

  expect(ada.toString()).toBe('Shopping:\neggs\nbread\n');
  expect(ben.toString()).toBe(ada.toString());

  // --- After a partition
  ben.applyUpdate(ada.encodeChangesSince(ben.version()));
  ada.applyUpdate(ben.encodeChangesSince(ada.version()));

  const cy = TextDoc.load(ada.save());
  const first = ada.insert(0, '# ');
  const second = ada.insert(2, 'List');

  expect(cy.apply(second)).toBe('buffered');
  expect(cy.apply(first)).toBe('applied');
  expect(cy.apply(first)).toBe('duplicate');
  expect(cy.toString()).toBe(ada.toString());

  // --- Anchors and events
  const caret = ben.anchor(10);
  const seen: ChangeEvent[] = [];
  ben.onChange((e) => seen.push(e));
  ben.apply(first);
  expect(ben.resolve(caret)).toBe(12);
  expect(seen).toMatchObject([{ origin: 'remote', changes: [{ kind: 'insert', index: 0, text: '# ' }] }]);

  // --- save / load
  const resumed = TextDoc.load(ada.save(), { replicaId: 'ada' });
  expect(resumed.toString()).toBe(ada.toString());
  expect(resumed.insert(0, '!').id).toEqual({ replica: 'ada', counter: ada.version()['ada'] });
  expect(TextDoc.load(ada.save()).replicaId).not.toBe('ada');
});
