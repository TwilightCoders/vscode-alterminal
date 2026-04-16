cmake_minimum_required(VERSION 3.20)
project(alterminald LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Find libloom — installed or via LOOM_DIR hint
if(DEFINED LOOM_DIR)
  # Development: point at loompty source/build tree
  set(LOOM_INCLUDE_DIR "${LOOM_DIR}/core/include")
  set(LOOM_LIB_DIR "${LOOM_DIR}/build")
else()
  # Installed: use pkg-config or find_library
  find_path(LOOM_INCLUDE_DIR loom/loom.h)
  find_library(LOOM_STATIC_LIB loom)
  get_filename_component(LOOM_LIB_DIR "${LOOM_STATIC_LIB}" DIRECTORY)
endif()

# libuv (required by libloom)
find_package(PkgConfig REQUIRED)
pkg_check_modules(UV REQUIRED IMPORTED_TARGET libuv)

# nlohmann/json (libloom links against it; header needed at link time)
include(FetchContent)
FetchContent_Declare(json
  URL https://github.com/nlohmann/json/releases/download/v3.11.3/json.hpp
  DOWNLOAD_NO_EXTRACT TRUE
  DOWNLOAD_DIR ${CMAKE_BINARY_DIR}/include/nlohmann
)
FetchContent_MakeAvailable(json)

add_executable(alterminald main.cpp)
target_include_directories(alterminald PRIVATE
  ${LOOM_INCLUDE_DIR}
  ${CMAKE_BINARY_DIR}/include
)
target_link_libraries(alterminald PRIVATE
  ${LOOM_LIB_DIR}/libloom.a
  PkgConfig::UV
)
