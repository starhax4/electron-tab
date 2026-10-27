// The main window runs the checks; the second window loads the same page with #second.
if (location.hash === '#second') await import('./second.js');
else await import('./checks.js');
