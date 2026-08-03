import { createFileRoute } from '@tanstack/react-router';

function PostDetailPage() {
  return <div>Post</div>;
}

export const Route = createFileRoute('/posts/$postId')({
  component: PostDetailPage,
});
