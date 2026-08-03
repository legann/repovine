import { Route, Routes } from 'react-router-dom';

function HomePage() {
  return <main>Home</main>;
}

function ProjectPage() {
  return <main>Project</main>;
}

function CategoriesPage() {
  return <main>Categories</main>;
}

function FilesPage() {
  return <main>Files</main>;
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/projects/:projectId" element={<ProjectPage />} />
      <Route path="/:lang?/categories" element={<CategoriesPage />} />
      <Route path="/files/*" element={<FilesPage />} />
    </Routes>
  );
}
