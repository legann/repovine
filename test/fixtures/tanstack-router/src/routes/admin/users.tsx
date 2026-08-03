import { createFileRoute } from '@tanstack/react-router';

function AdminUsersPage() {
  return <div>Users</div>;
}

export const Route = createFileRoute('/admin/users')({
  component: AdminUsersPage,
});
