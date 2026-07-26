import { createFileRoute } from '@tanstack/react-router';

function PostCategoryPage() {
  return <div>Post category</div>;
}

export const Route = createFileRoute('/posts/{-$category}')({
  component: PostCategoryPage,
});
