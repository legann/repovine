import { createFileRoute } from '@tanstack/react-router';

function FilesPage() {
  return <div>Files</div>;
}

export const Route = createFileRoute('/files/$')({
  component: FilesPage,
});
