import { createRootRoute, createRoute } from '@tanstack/react-router';

function RootLayout() {
  return <div>Root</div>;
}

function SettingsPage() {
  return <div>Settings</div>;
}

export const rootRoute = createRootRoute({
  component: RootLayout,
});

export const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  component: SettingsPage,
});
