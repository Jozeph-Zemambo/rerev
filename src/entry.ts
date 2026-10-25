/**
 * `/?booth` is the laptop's attract screen for the demo table: a page of its own that never
 * asks for AR, the microphone or the backend. Anything else is the app.
 */
if (new URLSearchParams(location.search).has('booth')) void import('./booth/attract');
else void import('./main');
