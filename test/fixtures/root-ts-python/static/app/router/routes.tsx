import type {RouteObject} from 'react-router-dom';

export const appRoutes: RouteObject[] = [
  {
    path: '/health/',
    component: () => null,
  },
  {
    index: true,
    component: () => null,
  },
];
