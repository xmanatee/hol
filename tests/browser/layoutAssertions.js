import { expect } from '@playwright/test';

export const expectWithinViewport = async (locator) => {
  await expect(locator).toBeVisible();
  const bounds = await locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: window.innerWidth,
      height: window.innerHeight,
    };
  });
  expect(bounds.left).toBeGreaterThanOrEqual(0);
  expect(bounds.top).toBeGreaterThanOrEqual(0);
  expect(bounds.right).toBeLessThanOrEqual(bounds.width);
  expect(bounds.bottom).toBeLessThanOrEqual(bounds.height);
};

export const expectReachableButton = async (button) => {
  await button.scrollIntoViewIfNeeded();
  await expectWithinViewport(button);
  expect(
    await button.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return (
        rect.width >= 44 &&
        rect.height >= 44 &&
        element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2))
      );
    }),
  ).toBe(true);
};
