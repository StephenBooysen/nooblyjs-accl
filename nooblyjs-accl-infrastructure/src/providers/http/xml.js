// Just enough XML for the AWS Query APIs' answers (EC2, STS, CloudWatch): elements, text and entities. Attributes,
// comments and the declaration are skipped. No dependency.
const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e] ?? m));

/** → the root element: { name, children: [...], text } */
export function parseXml(text) {
  const root = { name: '#document', children: [], text: '' };
  const stack = [root];
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<(\/?)([A-Za-z_][\w:.-]*)[^>]*?(\/?)>|([^<]+)/g;
  for (let m; (m = re.exec(String(text)));) {
    const top = stack.at(-1);
    if (m[1] !== undefined) top.text += m[1];
    else if (m[3]) {
      const name = m[3].replace(/^.*:/, '');
      if (m[2]) {
        if (stack.length > 1) stack.pop();
      } else {
        const node = { name, children: [], text: '' };
        top.children.push(node);
        if (!m[4]) stack.push(node);
      }
    } else if (m[5] !== undefined) top.text += decode(m[5]);
  }
  return root.children[0] ?? root;
}

export const child = (node, name) => node?.children?.find((c) => c.name === name) ?? null;
export const children = (node, name) => node?.children?.filter((c) => c.name === name) ?? [];
/** The node at a path of element names: at(root, 'reservationSet', 'item'). */
export const at = (node, ...names) => names.reduce((n, k) => child(n, k), node);
/** Trimmed text of a child (or of the node itself), or null. */
export const textOf = (node, ...names) => {
  const n = names.length ? at(node, ...names) : node;
  return n ? n.text.trim() : null;
};
/** The <item>s (or <member>s) of a set: items(node, 'instancesSet'). */
export const items = (node, ...names) => {
  const set = at(node, ...names);
  return set ? set.children.filter((c) => c.name === 'item' || c.name === 'member') : [];
};
