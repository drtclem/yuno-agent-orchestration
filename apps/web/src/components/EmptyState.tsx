import { Link } from 'react-router';

export function EmptyState({
  title,
  description,
  action = 'Load a template',
  to = '/templates',
}: {
  title: string;
  description: string;
  action?: string;
  to?: string;
}) {
  return (
    <section className="empty-state">
      <span className="empty-mark" aria-hidden="true">
        ↗
      </span>
      <h2>{title}</h2>
      <p>{description}</p>
      <Link className="button" to={to}>
        {action}
      </Link>
    </section>
  );
}
