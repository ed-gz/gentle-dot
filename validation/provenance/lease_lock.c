#include <sys/file.h>
#include "lease_lock.h"
int capri_lease_lock(int descriptor) { return flock(descriptor, LOCK_EX | LOCK_NB); }
int capri_lease_unlock(int descriptor) { return flock(descriptor, LOCK_UN); }
