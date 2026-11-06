import { describe, expect, it, vi } from 'vitest';
import { ReportsClient } from '../src/services/api/reportsClient';

describe('ReportsClient', () => {
  it('uploads sanitized evidence before creating the pending report', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        reportId: 'report-1',
        uploadUrl: 'https://uploads.example/report-1',
        expiresInSeconds: 300,
      }), { status: 201, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response('', { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        reportId: 'report-1',
        status: 'PENDING_REVIEW',
        submittedAt: '2026-11-06T00:00:00Z',
      }), { status: 201, headers: { 'Content-Type': 'application/json' } }));
    const client = new ReportsClient({ baseUrl: 'https://api.example', fetchImpl });
    const photo = new Blob(['photo'], { type: 'image/jpeg' });

    const result = await client.submit(photo, {
      description: 'The library lift is not responding.',
      locationId: 'srm-library',
      issueType: 'lift_outage',
    });

    expect(result.status).toBe('PENDING_REVIEW');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls[1][0]).toBe('https://uploads.example/report-1');
    expect(fetchImpl.mock.calls[1][1]).toMatchObject({ method: 'PUT', body: photo });
    expect(JSON.parse(String(fetchImpl.mock.calls[2][1].body))).toMatchObject({
      reportId: 'report-1',
      locationId: 'srm-library',
    });
  });
});
