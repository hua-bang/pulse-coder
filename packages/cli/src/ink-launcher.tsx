import React from 'react';

import { InkCliApp } from './ink-app.js';
import { createInkCoderController } from './ink-controller.js';

export async function startInkTui(): Promise<void> {
  const [{ render, Box, Text, useApp, useInput, useStdout }] = await Promise.all([
    import('ink'),
  ]);
  const controller = await createInkCoderController();
  const instance = render(
    <InkCliApp
      controller={controller}
      runtime={{ Box, Text, useApp, useInput, useStdout }}
    />,
  );

  await instance.waitUntilExit();
}
