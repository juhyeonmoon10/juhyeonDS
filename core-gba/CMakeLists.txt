cmake_minimum_required(VERSION 3.16)
project(juhyeonds_gba C)

set(MGBA_DIR "" CACHE PATH "Path to an mGBA source checkout")
if (NOT EXISTS "${MGBA_DIR}/src/gba/gba.c")
    message(FATAL_ERROR "Set -DMGBA_DIR=<path to mGBA source>")
endif()

if (NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()
set(CMAKE_C_FLAGS_RELEASE "-O3 -DNDEBUG")
# mGBA builds as strict C11; Emscripten only declares POSIX functions (strdup, PATH_MAX…) on request.
set(CMAKE_C_FLAGS "${CMAKE_C_FLAGS} -D_GNU_SOURCE -D_DEFAULT_SOURCE")

# Library only: no frontends, no optional dependencies, single-threaded.
set(LIBMGBA_ONLY ON)
set(M_CORE_GBA ON)
set(M_CORE_GB ON)
set(BUILD_STATIC ON CACHE BOOL "" FORCE)
set(BUILD_SHARED OFF CACHE BOOL "" FORCE)
set(DISABLE_THREADING ON CACHE BOOL "" FORCE)
set(BUILD_GL OFF CACHE BOOL "" FORCE)
set(BUILD_GLES2 OFF CACHE BOOL "" FORCE)
set(BUILD_GLES3 OFF CACHE BOOL "" FORCE)
set(USE_EPOXY OFF CACHE BOOL "" FORCE)
set(BUILD_LTO OFF CACHE BOOL "" FORCE)
set(SKIP_GIT ON CACHE BOOL "" FORCE)

add_subdirectory("${MGBA_DIR}" mgba-core)

add_executable(mgba_web glue.c)
set_target_properties(mgba_web PROPERTIES OUTPUT_NAME mgba)
target_link_libraries(mgba_web PRIVATE mgba)
target_include_directories(mgba_web PRIVATE "${MGBA_DIR}/include" "${CMAKE_CURRENT_BINARY_DIR}/mgba-core/include")
target_link_options(mgba_web PRIVATE
    -sMODULARIZE=1
    -sEXPORT_NAME=createMGBA
    -sENVIRONMENT=web,worker,node
    -sALLOW_MEMORY_GROWTH=1
    -sINITIAL_MEMORY=67108864
    -sMAXIMUM_MEMORY=1073741824
    -sSTACK_SIZE=1048576
    -sFILESYSTEM=1
    -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAP16
    -sEXIT_RUNTIME=0
    --no-entry)
