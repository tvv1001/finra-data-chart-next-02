'use client';
import dynamic from 'next/dynamic';

const FinraGraph = dynamic(() => import('@/components/FinraGraph'), {
  ssr: false,
  loading: () => <div style={{ padding: '2rem', color: '#aaa' }}>Loading graph…</div>,
});

export default function HomePage() {
  return <FinraGraph />;
}
