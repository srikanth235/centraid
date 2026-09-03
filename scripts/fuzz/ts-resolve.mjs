export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    const notFound = error.code === "ERR_MODULE_NOT_FOUND";
    if (!notFound || !specifier.startsWith(".") || !specifier.endsWith(".js"))
      throw error;
    return await nextResolve(`${specifier.slice(0, -3)}.ts`, context);
  }
}
