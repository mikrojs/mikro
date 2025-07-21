# MicroJS

> Experimental JavaScript runtime for microcontrollers with an unapologetic focus on type safety

## Features

- Powered by [QuickJS-NG](https://quickjs-ng.github.io/quickjs/), which
  means [almost complete support](https://quickjs-ng.github.io/quickjs/es_features) for modern ECMAScript
  features
- Unapologetic focus on type safety and TypeScript support:
  - Result pattern is preferred over throwing and try/catch

## Supported platforms

This library is in its early days, not a lot extensive testing has been performed and
the [esp-idf](https://www.espressif.com/en/products/sdks/esp-idf) is currently the only supported platform.

### Prerequisites

- direnv (https://direnv.net/)
- The required software packages
  listed [in the official esp-idf get started guide](https://docs.espressif.com/projects/esp-idf/en/stable/esp32/get-started/linux-macos-setup.html#step-1-install-prerequisites)

```sh
git clone --recursive --shallow-submodules https://github.com/bjoerge/microjs
cd microjs
direnv allow
sh ./esp-idf/install.sh
. ./esp-idf/export.sh
```

You might also need to run the following command (see the official
guide [here](https://docs.espressif.com/projects/esp-idf/en/stable/esp32/get-started/linux-macos-setup.html#:~:text=For%20macOS%20users%2C%20if%20an%20error%20like%20this%20is%20shown%20during%20any%20step%3A))

```sh
sudo /Applications/Python\ 3.13/Install\ Certificates.command
```

## CLion Integration

Using direnv and opening the project in CLion from the project root via the terminal (eg. `clion .`) should work out of
the box.


## Run main/dev app on a device
The main/dev app is configured by the root sdkconfig file and can be run via idf.py from the project root:

```sh
# set the idf target
idf.py set-target esp32c6
# build and flash the app
idf.py build flash monitor
```

## Running tests on a device
Make sure to set the idf target before running the tests, e.g:
```
cd test && idf.py set-target esp32c6
```
Now, the test suite can be run with:
```
sh test.sh
```
