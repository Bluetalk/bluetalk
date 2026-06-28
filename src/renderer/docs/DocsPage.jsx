import React, { useMemo } from 'react';
import { useLocation, Navigate } from 'react-router-dom';
import DocsLayout from './DocsLayout';
import { flattenDocsNav } from './docsNav';

const contentModules = import.meta.glob('./content/**/*.md', { query: '?raw', import: 'default', eager: true });

function slugFromPath(path) {
  return path
    .replace('./content/', '')
    .replace(/\.md$/, '');
}

const CONTENT_BY_SLUG = Object.fromEntries(
  Object.entries(contentModules).map(([path, raw]) => [slugFromPath(path), raw]),
);

export default function DocsPage() {
  const location = useLocation();
  const slug = useMemo(() => {
    const match = location.pathname.match(/^\/docs\/?(.*)$/);
    return (match?.[1] || '').replace(/\/$/, '') || 'getting-started';
  }, [location.pathname]);

  if (slug === '' || slug === 'index') {
    return <Navigate to="/docs/getting-started" replace />;
  }

  const content = CONTENT_BY_SLUG[slug];
  const flat = flattenDocsNav();
  const index = flat.findIndex((item) => item.slug === slug);
  const prev = index > 0 ? flat[index - 1] : null;
  const next = index >= 0 && index < flat.length - 1 ? flat[index + 1] : null;

  if (!content) {
    return (
      <DocsLayout
        slug={slug}
        content={`# Page not found\n\nNo documentation page matches \`${slug}\`.`}
        prev={prev}
        next={next}
      />
    );
  }

  return (
    <DocsLayout slug={slug} content={content} prev={prev} next={next} />
  );
}
