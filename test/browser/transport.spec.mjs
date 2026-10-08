// A Transport attached to a WebTerm, across a reconnect.
import { expect, test } from '@playwright/test';

import { boot } from './helpers.mjs';

test('input reaches the new connection after reconnecting() reconnects', async ({ page }) => {
  await boot(page);

  const sent = await page.evaluate(async () => {
    const { reconnecting } = await import('/dist/transport/index.js');
    const made = [];
    const factory = () => {
      const fake = {
        name: `fake${made.length}`,
        sent: [],
        start(sink) {
          fake.sink = sink;
        },
        send(bytes) {
          fake.sent.push(new TextDecoder().decode(bytes));
        },
        close() {},
      };
      made.push(fake);
      return fake;
    };
    const opened = [];
    const transport = reconnecting(factory, { delayMs: 10, onOpen: (t) => opened.push(t.name) });
    window.term.attach(transport);
    await new Promise((r) => setTimeout(r, 0));

    window.term.input('a');
    // The server drops the connection. reconnecting() reports the close and
    // opens a second one.
    made[0].sink.closed();
    await new Promise((r) => setTimeout(r, 100));
    window.term.input('b');
    window.term.detach();
    return { first: made[0].sent, second: made[1]?.sent, opened };
  });

  expect(sent.first).toEqual(['a']);
  expect(sent.second).toEqual(['b']);
  expect(sent.opened).toEqual(['fake0', 'fake1']);
});
