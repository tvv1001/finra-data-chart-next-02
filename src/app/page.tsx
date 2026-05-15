'use client';
import dynamic from 'next/dynamic';

const FinraGraph = dynamic(() => import('@/components/FinraGraph'), {
  ssr: false,
  loading: () => null,
});

export default function HomePage() {
  return <FinraGraph />;
}
