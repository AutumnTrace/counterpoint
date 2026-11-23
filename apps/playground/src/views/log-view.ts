/** The message log: every delivered (or lost) message, newest first. */
import type { Msg } from '../network.ts';

const NAMES = ['Ada', 'Ben', 'Cy'];
const KEYS = ['ada', 'ben', 'cy'];
const KIND_LABEL = { ops: 'ops', hello: 'version', 'catch-up': 'catch-up' } as const;
const MAX = 120;

export class LogView {
  readonly el: HTMLOListElement;
  private readonly start = performance.now();
  private count = 0;

  constructor(el: HTMLOListElement) {
    this.el = el;
  }

  add(msg: Msg, outcome: string, lost: boolean): void {
    const li = document.createElement('li');
    li.className = `log__item log__item--${msg.kind}${lost ? ' is-lost' : ''}${/duplicate/.test(outcome) && !/applied/.test(outcome) ? ' is-dup' : ''}${/buffered \d/.test(outcome) ? ' is-buffered' : ''}`;
    const t = ((msg.deliverAt - this.start) / 1000).toFixed(1).padStart(5, ' ');
    li.innerHTML = `
      <span class="log__time">${t}s</span>
      <span class="log__route"><b class="c-${KEYS[msg.from]}">${NAMES[msg.from]}</b><span aria-hidden="true">→</span><b class="c-${KEYS[msg.to]}">${NAMES[msg.to]}</b></span>
      <span class="log__kind">${KIND_LABEL[msg.kind]}${msg.copy ? ' <i>dup</i>' : ''}</span>
      <span class="log__label"></span>
      <span class="log__bytes">${msg.bytes.length} B</span>
      <span class="log__outcome"></span>`;
    li.querySelector('.log__label')!.textContent = msg.label;
    li.querySelector('.log__outcome')!.textContent = outcome;
    this.el.prepend(li);
    this.count++;
    while (this.el.childElementCount > MAX) this.el.lastElementChild!.remove();
  }

  note(text: string): void {
    const li = document.createElement('li');
    li.className = 'log__item log__item--note';
    const t = ((performance.now() - this.start) / 1000).toFixed(1).padStart(5, ' ');
    li.innerHTML = `<span class="log__time">${t}s</span><span class="log__note"></span>`;
    li.querySelector('.log__note')!.textContent = text;
    this.el.prepend(li);
  }

  clear(): void {
    this.el.replaceChildren();
    this.count = 0;
  }

  get size(): number {
    return this.count;
  }
}
