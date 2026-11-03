'use client';

export default function Controls() {
  return <main><h1>Failure controls</h1><button>Duplicate</button><button>Duplicate</button><button disabled>Disabled control</button><button style={{ display: 'none' }}>Hidden control</button><button onClick={() => { throw new Error('Synthetic fixture page error'); }}>Throw page error</button><button onClick={() => alert('Synthetic dialog')}>Open dialog</button><button onClick={() => window.open('/pricing', '_blank')}>Open popup</button><a download="synthetic.txt" href="data:text/plain,Synthetic%20download">Download synthetic file</a><label htmlFor="synthetic-file">Choose synthetic file</label><input id="synthetic-file" type="file" /><aside className="secret" data-testid="synthetic-secret">SYNTHETIC_SECRET_DO_NOT_SHARE_9f8b7c6d</aside></main>;
}
