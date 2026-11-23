/* The PASS/FAIL line every suite prints, and the list it counts from.

   Each suite used to carry its own copy of these four lines, and the copies
   drifted: some pushed `ok` as given, some as a boolean, one cut long details
   short. They print the same thing, so they are one function now.

     const { results, check } = createChecks();
     check('the page loads', response.ok, `status ${response.status}`);
     const failed = results.filter((r) => !r.ok);

   `results` holds `{ name, ok }` with `ok` always a boolean, so the
   `results.filter((r) => !r.ok)` each suite ends with keeps working as it was.
   `maxDetail` trims the detail text for suites whose details are whole page
   dumps. `entry` is for the suites whose summary reads something else out of
   `results` — `{ n, ok }`, a bare boolean, the detail kept too — and builds
   that from the same three arguments `check` was given. A suite that keeps
   its own `results` array, declared apart from `check`, passes it in. */
export function createChecks({
  results = [],
  maxDetail = Infinity,
  separator = '  — ',
  entry = (name, ok) => ({ name, ok: Boolean(ok) }),
} = {}) {
  const check = (name, ok, detail = '') => {
    results.push(entry(name, ok, detail));
    const shown = detail ? `${separator}${String(detail).slice(0, maxDetail)}` : '';
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${shown}`);
  };
  return { results, check };
}

export default createChecks;
