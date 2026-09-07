export function planBuild(nodes) {
  const pending = new Map(
    nodes.map((node) => [node.id, new Set(node.dependencies)]),
  )
  const order = []
  while (pending.size) {
    const ready = [...pending.entries()]
      .filter(([, dependencies]) =>
        [...dependencies].every((id) => order.includes(id)),
      )
      .map(([id]) => id)
      .sort()
    if (!ready.length) throw new Error('Dependency cycle')
    for (const id of ready) {
      order.push(id)
      pending.delete(id)
    }
  }
  return order
}
