cmake_minimum_required(VERSION 3.16)
project(melonds_web C CXX)

set(MELONDS_DIR "" CACHE PATH "Path to a melonDS source checkout")
if (NOT EXISTS "${MELONDS_DIR}/src/NDS.cpp")
    message(FATAL_ERROR "Set -DMELONDS_DIR=<path to melonDS source>")
endif()

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if (NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()
set(CMAKE_C_FLAGS_RELEASE "-O3 -DNDEBUG")
set(CMAKE_CXX_FLAGS_RELEASE "-O3 -DNDEBUG")
set(CMAKE_INTERPROCEDURAL_OPTIMIZATION ON)
# Newer libc++ no longer pulls these in transitively; melonDS 1.1 relies on them.
set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -include cstdlib -include cstring -include cstdio")

list(APPEND CMAKE_MODULE_PATH "${MELONDS_DIR}/cmake")
include(CheckLibraryExists)

set(ENABLE_JIT OFF)
set(ENABLE_OGLRENDERER OFF)
set(ENABLE_GDBSTUB OFF)
set(ENABLE_JIT_PROFILING OFF)

add_subdirectory("${MELONDS_DIR}/src" melonds-core)

add_executable(melonds glue.cpp)
target_link_libraries(melonds PRIVATE core)
target_link_options(melonds PRIVATE
    -sMODULARIZE=1
    -sEXPORT_NAME=createMelonDS
    -sENVIRONMENT=web,worker,node
    -sALLOW_MEMORY_GROWTH=1
    -sINITIAL_MEMORY=134217728
    -sMAXIMUM_MEMORY=2147483648
    -sSTACK_SIZE=1048576
    -sFILESYSTEM=1
    -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAP16
    -sEXIT_RUNTIME=0
    --no-entry)
