import { expect, test, type Page } from '@playwright/test';

const editors = (page: Page) => ['ada', 'ben', 'cy'].map((k) => page.getByTestId(`editor-${k}`));

async function setSlider(page: Page, testId: string, value: number) {
  await page.getByTestId(testId).evaluate((el, v) => {
    const input = el as HTMLInputElement;
    input.value = String(v);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

async function values(page: Page): Promise<string[]> {
  return Promise.all(editors(page).map((e) => e.inputValue()));
}

/** Resolves once all three editors show the same text and nothing is in flight. */
async function expectConverged(page: Page) {
  await expect(page.getByTestId('sync-state')).toHaveText('replicas agree', { timeout: 20_000 });
  const [a, b, c] = await values(page);
  expect(b).toBe(a);
  expect(c).toBe(a);
  return a!;
}

test.beforeEach(async ({ page }) => {
  await page.goto('./');
  await setSlider(page, 'latency', 150);
  await expectConverged(page);
});

test('partition, edit on both sides, heal: all three editors converge', async ({ page }) => {
  const [ada, ben, cy] = editors(page);
  await page.getByTestId('partition-ada').click();
  await expect(page.getByTestId('status-ada')).toHaveText('partitioned');

  await ada!.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('Ada was offline.');
  await ben!.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('Ben kept going.');

  // Ben's edit reaches Cy, Ada's reaches nobody.
  await expect(cy!).toHaveValue(/Ben kept going\.$/);
  await expect(ada!).not.toHaveValue(/Ben/);
  await expect(page.getByTestId('sync-state')).toHaveText('partitioned');

  await page.getByTestId('heal-all').click();
  const text = await expectConverged(page);
  // Both sentences arrive whole: typed concurrently at the same spot, never interleaved.
  expect(text).toMatch(/(Ada was offline\.Ben kept going\.|Ben kept going\.Ada was offline\.)$/);
});

test('the interleaving scenario keeps both list items whole', async ({ page }) => {
  await page.getByTestId('run-scenario').click();
  const result = page.getByTestId('result-fugue');
  await expect(result).toBeVisible({ timeout: 30_000 });
  const text = await expectConverged(page);
  expect(['Shopping:\n- milk\n- eggs\n- bread\n', 'Shopping:\n- milk\n- bread\n- eggs\n']).toContain(text);
  await expect(result).toContainText('both items whole');
  // The baseline, fed the same keystrokes, interleaves them.
  const naive = page.getByTestId('result-naive');
  await expect(naive).toContainText('interleaved');
  await expect(naive.locator('pre')).toContainText('ebgrgesa');
});

test('a remote insert before the caret moves the caret with the text', async ({ page }) => {
  const [ada, , cy] = editors(page);
  await cy!.click();
  await cy!.evaluate((el) => (el as HTMLTextAreaElement).setSelectionRange(5, 5));
  await ada!.click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.type('>>> ');
  await expect(cy!).toHaveValue(/^>>> /);
  const caret = await cy!.evaluate((el) => (el as HTMLTextAreaElement).selectionStart);
  expect(caret).toBe(9);
});

test('converges with heavy reordering and duplication', async ({ page }) => {
  await setSlider(page, 'jitter', 900);
  await setSlider(page, 'duplication', 0.5);
  const eds = editors(page);
  for (let round = 0; round < 3; round++) {
    for (const [i, ed] of eds.entries()) {
      await ed.click();
      await page.keyboard.press('Control+End');
      await page.keyboard.type(`${'abc'[i]}${round}`, { delay: 15 });
    }
  }
  await page.getByTestId('editor-ben').click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('Delete');
  await page.keyboard.press('Delete');
  const text = await expectConverged(page);
  for (const piece of ['a0', 'b1', 'c2']) expect(text).toContain(piece);
  await expect(page.getByTestId('log')).toContainText('dup');
});
