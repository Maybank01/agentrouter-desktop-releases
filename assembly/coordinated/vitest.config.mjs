export default {
  test: {
    include: ['apps/desktop/tests/{project-manager,update-coordinator,host-process,host-protocol,seed-store,core-package-set,staging-processes}.spec.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
}
