#ifndef CONVEX_EMBEDDED_MOBILE_H
#define CONVEX_EMBEDDED_MOBILE_H

#include <stddef.h>
#include <stdint.h>

typedef struct CemBuffer {
  uint8_t *ptr;
  uintptr_t len;
  uintptr_t capacity;
} CemBuffer;

uint32_t cem_api_version(void);

uint64_t cem_open_path(const char *path, const char *selector_key,
                       const char *default_identity_key, CemBuffer *error);

CemBuffer cem_request(uint64_t handle, const uint8_t *bytes, uintptr_t len);

double cem_clock_read_value(uint64_t handle, CemBuffer *error);

CemBuffer cem_close(uint64_t handle);

void cem_buffer_free(CemBuffer buffer);

#endif
