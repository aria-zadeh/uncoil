# Uncoil

Uncoil is an iPhone app that breaks a school assignment into small, concrete steps, estimates how long each step will take, and schedules those steps into the free time in a student's week. It is built for high school students who find that getting started is the hardest part of homework, including students with ADHD. Built by Aria Zadeh, Jaden Tan and Srihith Chennareddy for the 2026 Congressional App Challenge.

**Try it now.** Install TestFlight from the App Store on your iPhone, then open https://testflight.apple.com/join/TjyDXNYF. The beta is free, needs no account, and the App Store version is in review.

A student types in an assignment or pastes a teacher's email, and the app pulls out the tasks and their due dates. For each task the model writes three to seven steps, and the first one is always something physical that can be done right away. The home screen opens on that first step, the scheduler places the work around the hours the student has marked as busy, and a focus session keeps a timer on screen while they work. The scheduler learns from the student's real pace, so if twenty-minute steps keep taking thirty, it plans for thirty.

The model that writes the steps is a fine-tuned SmolLM2-360M that ships inside the app and runs on the phone through ExecuTorch. There is no account, no server and no network request of any kind, and the app works in Airplane Mode. Due dates are resolved by ordinary code rather than the model, because a model this small cannot count days reliably.

## Stack

React Native, Expo, TypeScript (strict), Expo Router, Zustand with AsyncStorage, NativeWind, Reanimated, expo-notifications, and react-native-executorch on the XNNPACK CPU backend. iOS 17 and later.

## Running it

```bash
git lfs install
git clone https://github.com/aria-zadeh/uncoil.git
cd uncoil
npm install
npx expo run:ios
```

A development build is required, since Expo Go cannot load the ExecuTorch native module. The model file in `assets/model/` is tracked with Git LFS. There is no API key, no `.env` and no configuration step.

`npm test` runs the unit and integration tests, including one that fails the build if any code path can reach the network. Model training, evaluation and export live in `train/` and run separately in Python.

## Layout

```
app/          screens (Expo Router)
components/   presentational components
store/        Zustand stores
services/     scheduler, due-date resolver, validation, model adapter
data/         local storage
types/        shared types
utils/        design tokens and helpers
assets/model/ the bundled model and tokenizer
train/        dataset build, fine-tuning, evaluation, export
__tests__/    unit and integration tests
```

## History

Uncoil is a rebuild of FOCAL, a web app Aria and Srihith built for MIT Beaver Works' CRE[AT]E Challenge, where it won the Audience Choice Award. FOCAL ran in a browser and sent homework to a cloud model. Uncoil moved everything onto the phone, and about ninety percent of the code is new. The app was called Tether until October 2026, so a few older identifiers still use that name. Commits appear as "Aria Zadeh" and "bob the builder"; both are Aria's account on two computers.

## License

The app source is this project's. The bundled model derives from [SmolLM2-360M-Instruct](https://huggingface.co/HuggingFaceTB/SmolLM2-360M-Instruct), Apache-2.0; its license text ships in `assets/model/`.
